import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ChessGame } from "@neurochess/chess";
import type {
  AiControlledTurnCommand,
  AiProvider,
  GameCommandIdentity,
} from "@neurochess/contracts";
import type { AiExecutionTransaction } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import type { AiProviderAdapter } from "../providers/adapter.js";

import { authorizeGameControl } from "./authorization.js";
import type { CommandPreparationTransaction, PreparedGameCommand } from "./command-preparation.js";
import { requireController } from "./controller-presence.js";
import { AiTurnError, GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";

export type AiAdapters = Readonly<Partial<Record<AiProvider, AiProviderAdapter>>>;
export type PrepareAiCommand = (
  tx: CommandPreparationTransaction,
  principal: Principal,
  command: GameCommandIdentity,
) => Promise<PreparedGameCommand>;

type AiExecutionRecheckTransaction = CommandPreparationTransaction &
  Pick<AiExecutionTransaction, "getAiController" | "getAiTurnReservation">;

function requireAiSeat(
  principal: Principal,
  restored: Omit<PreparedGameCommand, "game">,
  step = false,
) {
  const { stored, snapshot: persistedSnapshot, configuration, participants } = restored;
  authorizeGameControl(principal, stored);
  if (stored.state !== (step ? "paused" : "active")) {
    throw new GameRequestError("INVALID_GAME_STATE");
  }
  const seat = configuration?.seats[persistedSnapshot.turn];
  const participant = participants.find((entry) => entry.color === persistedSnapshot.turn);
  if (stored.isSandbox || seat?.type !== "ai" || participant?.seatType !== "ai") {
    throw new GameRequestError("FORBIDDEN");
  }
  return { seat, participantId: participant.id, color: persistedSnapshot.turn };
}

function prepareExecutionGame(restoredGame: ChessGame, step = false): ChessGame {
  // A paused step resumes only this in-memory aggregate, never the persisted snapshot.
  if (step && !restoredGame.resume().ok) throw new GameIntegrityError();
  return restoredGame;
}

export async function reserveAiExecution(
  tx: AiExecutionRecheckTransaction &
    Pick<AiExecutionTransaction, "reserveAiTurn" | "getOrCreateAiTurn">,
  principal: Principal,
  command: AiControlledTurnCommand,
  options: {
    readonly prepareCommand: PrepareAiCommand;
    readonly adapters: AiAdapters;
    readonly signal: AbortSignal;
  },
) {
  const restored = await options.prepareCommand(tx, principal, command);
  const { snapshot: persistedSnapshot } = restored;
  const selected = requireAiSeat(principal, restored, command.step);
  const executionGame = prepareExecutionGame(restored.game, command.step);
  await requireController(tx, command.gameId, command.controllerId);
  const pending = await tx.getAiTurnReservation(command.gameId);
  if (pending) {
    throw new AiTurnError(
      pending.state === "in_flight" ? "AI_TURN_IN_PROGRESS" : "AI_TURN_RECOVERY_REQUIRED",
    );
  }
  const adapter = options.adapters[selected.seat.provider];
  if (adapter?.provider !== selected.seat.provider) {
    throw new AiTurnError("AI_ADAPTER_UNAVAILABLE");
  }
  if (options.signal.aborted) throw new AiTurnError("AI_TURN_CANCELLED");
  const reservationId = randomUUID();
  await tx.reserveAiTurn({
    gameId: command.gameId,
    commandId: command.commandId,
    expectedVersion: command.expectedVersion,
    reservationId,
  });
  const turn = await tx.getOrCreateAiTurn({
    gameId: command.gameId,
    ply: persistedSnapshot.moves.length + 1,
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
  const executionSnapshot = executionGame.snapshot();
  return {
    selected,
    adapter,
    reservationId,
    invocation,
    context: {
      fen: executionSnapshot.fen,
      pgn: executionSnapshot.pgn,
      color: executionSnapshot.turn,
      turn: executionSnapshot.turn,
      legalMoves: [...executionSnapshot.legalMoves],
    },
  };
}

export type ReservedAiExecution = Awaited<ReturnType<typeof reserveAiExecution>>;

export async function recheckAiExecution(
  tx: AiExecutionRecheckTransaction,
  principal: Principal,
  command: AiControlledTurnCommand,
  reserved: ReservedAiExecution,
  prepareCommand: PrepareAiCommand,
) {
  const restored = await prepareCommand(tx, principal, command);
  const { stored, snapshot: persistedSnapshot } = restored;
  const selected = requireAiSeat(principal, restored, command.step);
  const executionGame = prepareExecutionGame(restored.game, command.step);
  await requireController(tx, command.gameId, command.controllerId);
  const pending = await tx.getAiTurnReservation(command.gameId);
  if (
    pending?.reservationId !== reserved.reservationId ||
    pending.state !== "in_flight" ||
    pending.commandId !== command.commandId ||
    pending.expectedVersion !== command.expectedVersion ||
    !isDeepStrictEqual(selected, reserved.selected)
  ) {
    throw new GameConflictError(persistedSnapshot);
  }
  return { stored, persistedSnapshot, executionGame };
}

export type RecheckedAiExecution = Awaited<ReturnType<typeof recheckAiExecution>>;
