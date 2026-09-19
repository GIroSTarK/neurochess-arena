import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import type { ChessGame } from "@neurochess/chess";
import {
  type AiGameConfiguration,
  type AiProvider,
  type AiRequestErrorCode,
  type AiTurnCommand,
  aiTurnCommandSchema,
  type GameSnapshot,
  type NormalizedMoveResponse,
} from "@neurochess/contracts";
import type {
  GameRepository,
  GameTransaction,
  InvocationResult,
  StoredGame,
  StoredParticipant,
} from "@neurochess/database";

import type { GuestPrincipal } from "../guests/service.js";
import {
  AI_MOVE_INSTRUCTIONS,
  type AiProviderAdapter,
  type ListModelsInput,
} from "../providers/adapter.js";
import { discoverModels, effectiveParameters } from "../providers/discovery.js";
import { cancellationFailure, invokeMove } from "../providers/invoke-move.js";

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
  constructor(readonly code: AiRequestErrorCode) {
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

function invocationResult(response: NormalizedMoveResponse, discarded = false): InvocationResult {
  const error = response.ok ? null : response.error;
  return {
    outcome: discarded
      ? "discarded"
      : response.ok
        ? "accepted"
        : error?.code === "model_invalid"
          ? "model_invalid"
          : "provider_error",
    errorCode: error?.code ?? null,
    errorReason: error && "reason" in error ? error.reason : null,
    durationMs: response.durationMs,
    usageReported: response.usage !== null,
    inputTokens: response.usage?.inputTokens ?? null,
    outputTokens: response.usage?.outputTokens ?? null,
    totalTokens: response.usage?.totalTokens ?? null,
    commentary: response.ok && !discarded ? (response.output.commentary ?? null) : null,
  };
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
      if (access.signal.aborted) throw new AiTurnError("AI_TURN_CANCELLED");
      const reservationId = randomUUID();
      await tx.reserveAiTurn({
        gameId: command.gameId,
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        reservationId,
      });
      const turn = await tx.getOrCreateAiTurn({
        gameId: command.gameId,
        ply: prepared.snapshot.moves.length + 1,
        color: selected.color,
      });
      if (
        turn.invalidOutputCount >= 3 ||
        turn.acceptedMovePly !== null ||
        turn.color !== selected.color
      ) {
        throw new GameIntegrityError();
      }
      const invocation = {
        turnId: turn.id,
        reservationId,
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        provider: selected.seat.provider,
        modelId: selected.seat.modelId,
      };
      const { snapshot } = prepared;
      return {
        selected,
        adapter,
        reservationId,
        invocation,
        context: {
          fen: snapshot.fen,
          pgn: snapshot.pgn,
          color: snapshot.turn,
          turn: snapshot.turn,
          legalMoves: [...snapshot.legalMoves],
        },
      };
    });

    async function recheck(tx: GameTransaction) {
      const prepared = await prepareCommand(tx, principal, command);
      const selected = aiSeat(principal, prepared);
      const pending = await tx.getAiTurnReservation(command.gameId);
      if (
        pending?.reservationId !== reserved.reservationId ||
        pending.state !== "in_flight" ||
        pending.commandId !== command.commandId ||
        pending.expectedVersion !== command.expectedVersion ||
        !isDeepStrictEqual(selected, reserved.selected)
      ) {
        throw new GameConflictError(prepared.snapshot);
      }
      return prepared;
    }

    let attempt: Awaited<ReturnType<GameTransaction["beginModelInvocation"]>> | undefined;
    let response: NormalizedMoveResponse | undefined;
    try {
      // Discovery shares the reservation fence with inference, but never holds database locks.
      const discoveryStarted = performance.now();
      const discovery = await discoverModels(reserved.adapter, access);
      const discoveryDurationMs = Math.max(0, Math.round(performance.now() - discoveryStarted));
      const model = discovery.ok
        ? discovery.models.find((entry) => entry.id === reserved.selected.seat.modelId)
        : undefined;
      const parameters = model
        ? effectiveParameters(reserved.selected.seat.parameters, model.capabilities)
        : {};
      if (parameters === null) {
        await repository.write(async (tx) => {
          const prepared = await recheck(tx);
          const paused = prepared.game.pause();
          if (!paused.ok) throw new GameIntegrityError();
          await persistCommand(tx, prepared.stored, command.commandId, "pause", paused.value);
        });
        throw new AiTurnError("AI_PARAMETERS_INVALID");
      }
      const invocation = { ...reserved.invocation, effectiveParameters: parameters };
      attempt = await repository.write(async (tx) => {
        await recheck(tx);
        return tx.beginModelInvocation(invocation);
      });
      const preparationError = !discovery.ok
        ? discovery.error
        : !model || model.capabilities.moveGeneration === "unsupported"
          ? ({ code: "provider_unavailable", reason: "unsupported_model" } as const)
          : null;
      for (;;) {
        response = preparationError
          ? {
              ok: false,
              error: preparationError,
              durationMs: discoveryDurationMs,
              usage: null,
              providerRequestId: null,
            }
          : await invokeMove(reserved.adapter, {
              apiKey: access.apiKey,
              signal: access.signal,
              instructions: AI_MOVE_INSTRUCTIONS,
              modelId: reserved.selected.seat.modelId,
              parameters: { ...invocation.effectiveParameters },
              context: { ...reserved.context, legalMoves: [...reserved.context.legalMoves] },
            });
        const currentAttempt = attempt;
        const received = response;
        const snapshot = await repository.write(async (tx) => {
          const prepared = await recheck(tx);
          let classified = received;
          if (classified.ok && !prepared.snapshot.legalMoves.includes(classified.output.move)) {
            classified = {
              ...classified,
              ok: false,
              error: { code: "model_invalid", reason: "illegal_move" },
            };
          }
          if (classified.ok && access.signal.aborted) {
            classified = { ...classified, ok: false, error: cancellationFailure(access.signal) };
          }
          if (
            !(await tx.finishModelInvocation(
              currentAttempt.id,
              reserved.reservationId,
              invocationResult(classified),
            ))
          ) {
            throw new GameIntegrityError();
          }
          if (!classified.ok && classified.error.code === "model_invalid") {
            if ((await tx.incrementAiInvalidCount(currentAttempt.turnId)) < 3) {
              if (!access.signal.aborted) return null;
              // Cancellation may stop retries, but cannot erase an already-observed invalid output.
              const paused = prepared.game.pause();
              if (!paused.ok) throw new GameIntegrityError();
              return persistCommand(tx, prepared.stored, command.commandId, "pause", paused.value);
            }
            const lost = prepared.game.recordTechnicalLoss(reserved.selected.color);
            if (!lost.ok) throw new GameIntegrityError();
            return persistCommand(
              tx,
              prepared.stored,
              command.commandId,
              "technical_loss",
              lost.value,
            );
          }
          const accepted = classified.ok
            ? prepared.game.playMove(classified.output.move)
            : prepared.game.pause();
          if (!accepted.ok) throw new GameIntegrityError();
          const result = await persistCommand(
            tx,
            prepared.stored,
            command.commandId,
            classified.ok ? "move" : "pause",
            accepted.value,
          );
          if (classified.ok) {
            await tx.linkAiTurnMove(currentAttempt.turnId, prepared.snapshot.moves.length + 1);
          }
          return result;
        });
        if (snapshot) return snapshot;
        response = undefined;
        const next = await repository.write(async (tx) => {
          const prepared = await recheck(tx);
          if (access.signal.aborted) {
            const paused = prepared.game.pause();
            if (!paused.ok) throw new GameIntegrityError();
            return {
              snapshot: await persistCommand(
                tx,
                prepared.stored,
                command.commandId,
                "pause",
                paused.value,
              ),
            };
          }
          return { attempt: await tx.beginModelInvocation(invocation) };
        });
        if (next.snapshot) return next.snapshot;
        attempt = next.attempt;
      }
    } catch (error: unknown) {
      try {
        await repository.write(async (tx) => {
          // Cleanup uses the server's attempt/fence identity, even if the principal has expired.
          await tx.lockGuest(principal.guestSessionId);
          await tx.lockGame(command.gameId);
          if (
            response &&
            attempt &&
            (error instanceof GameConflictError || error instanceof GameRequestError)
          ) {
            await tx.finishModelInvocation(
              attempt.id,
              reserved.reservationId,
              invocationResult(response, true),
              true,
            );
          }
          await tx.blockAiTurn(command.gameId, reserved.reservationId);
        });
      } catch {
        // A surviving reservation remains blocked from redispatch until explicit recovery.
      }
      throw error;
    }
  };
}
