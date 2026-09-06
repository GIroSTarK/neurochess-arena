import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import type {
  AiTurnCommand,
  CreateAiGameRequest,
  GamePgnResponse,
  GameReplayResponse,
  GameSnapshot,
  LifecycleCommand,
  ModelDiscoveryResult,
  MoveCommand,
  ProviderListResponse,
  SessionCredential,
  UnfinishedGameResponse,
} from "@neurochess/contracts";
import type { GameRepository } from "@neurochess/database";

import type { GuestPrincipal } from "../guests/service.js";

import { type AiGameOptions, createAiGameOperations } from "./ai-service.js";
import { authorizeGameControl, authorizeHumanSeat } from "./authorization.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";
import { positionOf, restoreAuthorized, transportSnapshot } from "./state.js";

export interface GameService {
  readonly sandboxEnabled: boolean;
  createSandbox(principal: GuestPrincipal): Promise<GameSnapshot>;
  createAi(principal: GuestPrincipal, request: CreateAiGameRequest): Promise<GameSnapshot>;
  unfinishedAi(principal: GuestPrincipal): Promise<UnfinishedGameResponse>;
  listProviders(principal: GuestPrincipal): Promise<ProviderListResponse>;
  discoverModels(
    principal: GuestPrincipal,
    credential: SessionCredential,
    signal?: AbortSignal,
  ): Promise<ModelDiscoveryResult>;
  aiTurn(
    principal: GuestPrincipal,
    command: AiTurnCommand,
    credential: SessionCredential,
    signal?: AbortSignal,
  ): Promise<GameSnapshot>;
  snapshot(principal: GuestPrincipal, gameId: string): Promise<GameSnapshot>;
  move(principal: GuestPrincipal, command: MoveCommand): Promise<GameSnapshot>;
  lifecycle(principal: GuestPrincipal, command: LifecycleCommand): Promise<GameSnapshot>;
  unfinished(principal: GuestPrincipal): Promise<UnfinishedGameResponse>;
  replay(principal: GuestPrincipal, gameId: string): Promise<GameReplayResponse>;
  pgn(principal: GuestPrincipal, gameId: string): Promise<GamePgnResponse>;
}

export function createGameService(
  repository: GameRepository,
  options: {
    readonly nodeEnv: "development" | "test" | "production";
    readonly sandboxEnabled: boolean;
    readonly ai?: AiGameOptions;
  },
): GameService {
  const sandboxEnabled = options.sandboxEnabled && options.nodeEnv !== "production";

  function readSnapshot(principal: GuestPrincipal, gameId: string): Promise<GameSnapshot> {
    return repository.read(async (reader) => {
      if (!(await reader.getGuest(principal.guestSessionId))) {
        throw new GameRequestError("UNAUTHORIZED");
      }
      const stored = await reader.getGame(gameId);
      if (!stored) throw new GameRequestError("NOT_FOUND");
      return (await restoreAuthorized(reader, principal, stored, sandboxEnabled)).snapshot;
    });
  }

  async function terminalSnapshot(principal: GuestPrincipal, gameId: string) {
    const snapshot = await readSnapshot(principal, gameId);
    if (snapshot.state !== "completed" && snapshot.state !== "aborted") {
      throw new GameRequestError("INVALID_GAME_STATE");
    }
    return snapshot;
  }

  function mutate(principal: GuestPrincipal, command: MoveCommand | LifecycleCommand) {
    return repository.write(async (tx) => {
      if (!(await tx.lockGuest(principal.guestSessionId))) {
        throw new GameRequestError("UNAUTHORIZED");
      }
      const stored = await tx.lockGame(command.gameId);
      if (!stored) throw new GameRequestError("NOT_FOUND");
      const restored = await restoreAuthorized(tx, principal, stored, sandboxEnabled);
      const commandId = command.commandId.toLowerCase();
      // Accepted IDs span every command kind, including retries after completion.
      if (
        command.expectedVersion !== stored.version ||
        (await tx.hasCommand(stored.id, commandId))
      ) {
        throw new GameConflictError(restored.snapshot);
      }
      const isMove = "move" in command;
      if (isMove) {
        if (stored.state !== "active") throw new GameRequestError("INVALID_GAME_STATE");
        authorizeHumanSeat(
          principal,
          stored,
          restored.participants,
          restored.snapshot.turn,
          sandboxEnabled,
        );
      } else if (command.action === "resign") {
        authorizeHumanSeat(
          principal,
          stored,
          restored.participants,
          command.losingColor,
          sandboxEnabled,
        );
      } else {
        authorizeGameControl(principal, stored);
      }
      // Pause also fences an interrupted or in-flight step whose persisted state is already paused.
      const cancelPausedStep =
        !isMove &&
        command.action === "pause" &&
        stored.state === "paused" &&
        !stored.isSandbox &&
        stored.mode !== "human_vs_human" &&
        (await tx.getTurnReservations(stored.id)).some((row) => row.status === "reserved");
      const accepted = cancelPausedStep
        ? ({ ok: true, value: restored.game.snapshot() } as const)
        : isMove
          ? restored.game.playMove(command.move)
          : command.action === "resign"
            ? restored.game.resignHuman(command.losingColor)
            : restored.game[command.action]();
      if (!accepted.ok) {
        if (["ILLEGAL_MOVE", "INVALID_UCI", "INVALID_GAME_STATE"].includes(accepted.error.code)) {
          throw new GameRequestError(
            accepted.error.code as "ILLEGAL_MOVE" | "INVALID_UCI" | "INVALID_GAME_STATE",
          );
        }
        throw new GameIntegrityError();
      }
      const snapshot = transportSnapshot(stored.id, stored.version + 1, accepted.value);
      await tx.appendCommand({
        gameId: stored.id,
        commandId,
        version: snapshot.version,
        kind: isMove ? "move" : command.action,
      });
      if (isMove) {
        const move = snapshot.moves.at(-1);
        if (!move) throw new GameIntegrityError();
        await tx.appendMove({ ...move, gameId: stored.id, commandId, version: snapshot.version });
      }
      if (!(await tx.updatePosition(stored.id, stored.version, positionOf(snapshot)))) {
        throw new GameIntegrityError();
      }
      return snapshot;
    });
  }

  return {
    ...createAiGameOperations(repository, sandboxEnabled, options.ai),
    sandboxEnabled,
    createSandbox: (principal) =>
      repository.write(async (tx) => {
        if (!sandboxEnabled) throw new GameRequestError("NOT_FOUND");
        if (!(await tx.lockGuest(principal.guestSessionId))) {
          throw new GameRequestError("UNAUTHORIZED");
        }
        const occupied = await tx.findUnfinishedGame(principal.guestSessionId);
        if (occupied) {
          const locked = await tx.lockGame(occupied.id);
          if (!locked) throw new GameIntegrityError();
          throw new GameConflictError(
            (await restoreAuthorized(tx, principal, locked, sandboxEnabled)).snapshot,
          );
        }
        const started = createGame().start();
        if (!started.ok) throw new GameIntegrityError();
        const snapshot = transportSnapshot(randomUUID(), 0, started.value);
        await tx.insertGame(
          {
            id: snapshot.gameId,
            ownerGuestSessionId: principal.guestSessionId,
            isSandbox: true,
            ...positionOf(snapshot),
          },
          [
            {
              gameId: snapshot.gameId,
              color: "white",
              seatType: "human",
              guestSessionId: principal.guestSessionId,
            },
            { gameId: snapshot.gameId, color: "black", seatType: "human", guestSessionId: null },
          ],
        );
        return snapshot;
      }),
    snapshot: readSnapshot,
    move: mutate,
    lifecycle: mutate,
    async replay(principal, gameId) {
      return {
        snapshot: await terminalSnapshot(principal, gameId),
        initialFen: createGame().snapshot().fen,
      };
    },
    async pgn(principal, gameId) {
      const snapshot = await terminalSnapshot(principal, gameId);
      return { gameId: snapshot.gameId, version: snapshot.version, pgn: snapshot.pgn };
    },
    unfinished: (principal) =>
      repository.read(async (reader) => {
        if (!sandboxEnabled) throw new GameRequestError("NOT_FOUND");
        if (!(await reader.getGuest(principal.guestSessionId))) {
          throw new GameRequestError("UNAUTHORIZED");
        }
        const stored = await reader.findUnfinishedGame(principal.guestSessionId, true);
        return {
          snapshot: stored
            ? (await restoreAuthorized(reader, principal, stored, sandboxEnabled)).snapshot
            : null,
        };
      }),
  };
}
