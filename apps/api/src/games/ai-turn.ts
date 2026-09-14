import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ChessGame } from "@neurochess/chess";
import {
  type AiGameConfiguration,
  type AiProvider,
  type AiTurnCommand,
  aiTurnCommandSchema,
  type GameSnapshot,
  normalizedMoveResponseSchema,
} from "@neurochess/contracts";
import type {
  GameRepository,
  GameTransaction,
  StoredGame,
  StoredParticipant,
} from "@neurochess/database";

import type { GuestPrincipal } from "../guests/service.js";
import {
  AI_MOVE_INSTRUCTIONS,
  type AiProviderAdapter,
  type ListModelsInput,
  type MoveRequest,
} from "../providers/adapter.js";

import { authorizeGameControl } from "./authorization.js";
import { persistCommand } from "./command-persistence.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";

interface PreparedCommand {
  readonly stored: StoredGame;
  readonly game: ChessGame;
  readonly snapshot: GameSnapshot;
  readonly participants: readonly StoredParticipant[];
  readonly configuration: AiGameConfiguration | null;
}

export type AiAdapters = Readonly<Partial<Record<AiProvider, AiProviderAdapter>>>;

export class AiTurnError extends Error {
  constructor(
    readonly code:
      | "AI_TURN_IN_PROGRESS"
      | "AI_TURN_RECOVERY_REQUIRED"
      | "AI_TURN_CANCELLED"
      | "AI_OUTPUT_INVALID"
      | "AI_PROVIDER_FAILED"
      | "AI_ADAPTER_UNAVAILABLE",
  ) {
    super(code);
    this.name = "AiTurnError";
  }
}

function aiSeat(principal: GuestPrincipal, prepared: PreparedCommand) {
  const { stored, snapshot, configuration, participants } = prepared;
  authorizeGameControl(principal, stored);
  if (stored.state !== "active") throw new GameRequestError("INVALID_GAME_STATE");
  const seat = configuration?.seats[snapshot.turn];
  const participant = participants.find((entry) => entry.color === snapshot.turn);
  if (stored.isSandbox || seat?.type !== "ai" || participant?.seatType !== "ai") {
    throw new GameRequestError("FORBIDDEN");
  }
  return { seat, participantId: participant.id, color: snapshot.turn };
}

function checkCancellation(signal: AbortSignal) {
  if (signal.aborted) throw new AiTurnError("AI_TURN_CANCELLED");
}

async function requestMove(adapter: AiProviderAdapter, input: MoveRequest): Promise<unknown> {
  checkCancellation(input.signal);
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(new AiTurnError("AI_TURN_CANCELLED"));
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        checkCancellation(input.signal);
        return adapter.requestMove(input);
      }),
      cancelled.promise,
    ]);
  } catch {
    // Neither adapter exceptions nor AbortSignal.reason may escape with request secrets.
    throw new AiTurnError(input.signal.aborted ? "AI_TURN_CANCELLED" : "AI_PROVIDER_FAILED");
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
}

export function createAiTurnExecutor(options: {
  readonly repository: GameRepository;
  readonly adapters: AiAdapters;
  readonly prepareCommand: (
    tx: GameTransaction,
    principal: GuestPrincipal,
    command: AiTurnCommand,
  ) => Promise<PreparedCommand>;
}) {
  const { repository, prepareCommand } = options;
  const adapters = { ...options.adapters };

  return async (
    principal: GuestPrincipal,
    input: unknown,
    access: ListModelsInput,
  ): Promise<GameSnapshot> => {
    const parsed = aiTurnCommandSchema.safeParse(input);
    if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
    const command = {
      ...parsed.data,
      gameId: parsed.data.gameId.toLowerCase(),
      commandId: parsed.data.commandId.toLowerCase(),
    };
    const reserved = await repository.write(async (tx) => {
      const prepared = await prepareCommand(tx, principal, command);
      const selected = aiSeat(principal, prepared);
      const pending = await tx.getAiTurnReservation(command.gameId);
      if (pending) {
        throw new AiTurnError(
          pending.state === "in_flight" ? "AI_TURN_IN_PROGRESS" : "AI_TURN_RECOVERY_REQUIRED",
        );
      }
      const adapter = adapters[selected.seat.provider];
      if (adapter?.provider !== selected.seat.provider) {
        throw new AiTurnError("AI_ADAPTER_UNAVAILABLE");
      }
      checkCancellation(access.signal);
      const reservationId = randomUUID();
      const { snapshot } = prepared;
      await tx.reserveAiTurn({
        gameId: command.gameId,
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        reservationId,
      });
      return {
        ...selected,
        adapter,
        reservationId,
        context: {
          fen: snapshot.fen,
          pgn: snapshot.pgn,
          color: snapshot.turn,
          turn: snapshot.turn,
          legalMoves: [...snapshot.legalMoves],
        },
      };
    });

    try {
      const response = normalizedMoveResponseSchema.safeParse(
        await requestMove(reserved.adapter, {
          apiKey: access.apiKey,
          signal: access.signal,
          instructions: AI_MOVE_INSTRUCTIONS,
          modelId: reserved.seat.modelId,
          parameters: { ...reserved.seat.parameters },
          context: reserved.context,
        }),
      );
      if (!response.success) throw new AiTurnError("AI_OUTPUT_INVALID");
      if (!response.data.ok) {
        throw new AiTurnError(
          response.data.error.code === "model_invalid" ? "AI_OUTPUT_INVALID" : "AI_PROVIDER_FAILED",
        );
      }
      const { move } = response.data.output;
      return await repository.write(async (tx) => {
        const prepared = await prepareCommand(tx, principal, command);
        const selected = aiSeat(principal, prepared);
        const pending = await tx.getAiTurnReservation(command.gameId);
        if (
          pending?.reservationId !== reserved.reservationId ||
          pending.state !== "in_flight" ||
          pending.commandId !== command.commandId ||
          pending.expectedVersion !== command.expectedVersion ||
          !isDeepStrictEqual(selected, {
            seat: reserved.seat,
            participantId: reserved.participantId,
            color: reserved.color,
          })
        ) {
          throw new GameConflictError(prepared.snapshot);
        }
        checkCancellation(access.signal);
        if (!prepared.snapshot.legalMoves.includes(move)) {
          throw new AiTurnError("AI_OUTPUT_INVALID");
        }
        const accepted = prepared.game.playMove(move);
        if (!accepted.ok) throw new GameIntegrityError();
        const snapshot = await persistCommand(
          tx,
          prepared.stored,
          command.commandId,
          "move",
          accepted.value,
        );
        checkCancellation(access.signal);
        return snapshot;
      });
    } catch (error: unknown) {
      try {
        await repository.write(async (tx) => {
          // Cleanup cannot require a still-valid principal: expiry may have caused the failure.
          await tx.lockGuest(principal.guestSessionId);
          await tx.lockGame(command.gameId);
          await tx.blockAiTurn(command.gameId, reserved.reservationId);
        });
      } catch {
        // An uncleared reservation is intentionally non-retryable until explicit recovery.
      }
      throw error;
    }
  };
}
