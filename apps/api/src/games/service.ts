import { createGame, restoreGame, type ChessGame, type ChessSnapshot } from "@neurochess/chess";
import {
  gameLifecycleSchema,
  gameSnapshotSchema,
  type GameSnapshot,
  type MoveCommand,
  type LifecycleCommand,
  type GameReplayResponse,
  type GamePgnResponse,
  type UnfinishedGameResponse,
} from "@neurochess/contracts";
import type {
  GameReader,
  GameRepository,
  StoredGame,
  StoredMove,
  StoredParticipant,
} from "@neurochess/database";
import { randomUUID } from "node:crypto";

import type { GuestPrincipal } from "../guests/service.js";

import { authorizeGameRead, authorizeHumanSeat, authorizeGameControl } from "./authorization.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";

export interface GameService {
  readonly sandboxEnabled: boolean;
  createSandbox(principal: GuestPrincipal): Promise<GameSnapshot>;
  snapshot(principal: GuestPrincipal, gameId: string): Promise<GameSnapshot>;
  move(principal: GuestPrincipal, command: MoveCommand): Promise<GameSnapshot>;
  lifecycle(principal: GuestPrincipal, command: LifecycleCommand): Promise<GameSnapshot>;
  unfinished(principal: GuestPrincipal): Promise<UnfinishedGameResponse>;
  replay(principal: GuestPrincipal, gameId: string): Promise<GameReplayResponse>;
  pgn(principal: GuestPrincipal, gameId: string): Promise<GamePgnResponse>;
}

interface RestoredGame {
  readonly game: ChessGame;
  readonly snapshot: GameSnapshot;
  readonly moves: StoredMove[];
  readonly participants: StoredParticipant[];
}

export function createGameService(
  repository: GameRepository,
  options: {
    readonly nodeEnv: "development" | "test" | "production";
    readonly sandboxEnabled: boolean;
  },
): GameService {
  const sandboxEnabled = options.sandboxEnabled && options.nodeEnv !== "production";

  async function restoreAuthorized(
    reader: GameReader,
    principal: GuestPrincipal,
    stored: StoredGame,
  ): Promise<RestoredGame> {
    const participants = await reader.getParticipants(stored.id);
    // Never reconstruct or disclose a private position before establishing access.
    authorizeGameRead(principal, stored, participants, sandboxEnabled);
    if (participants.length !== 2 || new Set(participants.map((seat) => seat.color)).size !== 2) {
      throw new GameIntegrityError();
    }
    const moves = await reader.getMoves(stored.id);
    const lifecycle = gameLifecycleSchema.safeParse({
      state: stored.state,
      result: stored.result,
      terminationReason: stored.terminationReason,
    });
    if (!lifecycle.success) throw new GameIntegrityError();
    const restored = restoreGame({
      moves: moves.map((move) => move.uci),
      lifecycle: lifecycle.data,
    });
    if (!restored.ok) throw new GameIntegrityError();
    const domain = restored.value.snapshot();
    if (domain.fen !== stored.fen || domain.pgn !== stored.pgn) throw new GameIntegrityError();
    let previousVersion = 0;
    for (const [index, move] of moves.entries()) {
      const replayed = domain.moves[index];
      if (
        !replayed ||
        replayed.ply !== move.ply ||
        replayed.san !== move.san ||
        replayed.fen !== move.fen ||
        !Number.isSafeInteger(move.version) ||
        move.version <= previousVersion ||
        move.version > stored.version
      ) {
        throw new GameIntegrityError();
      }
      previousVersion = move.version;
    }
    const snapshot = transportSnapshot(stored.id, stored.version, domain);
    return { game: restored.value, snapshot, moves, participants };
  }

  function readSnapshot(principal: GuestPrincipal, gameId: string): Promise<GameSnapshot> {
    return repository.read(async (reader) => {
      if (!(await reader.getGuest(principal.guestSessionId)))
        throw new GameRequestError("UNAUTHORIZED");
      const stored = await reader.getGame(gameId);
      if (!stored) throw new GameRequestError("NOT_FOUND");
      return (await restoreAuthorized(reader, principal, stored)).snapshot;
    });
  }

  async function terminalSnapshot(principal: GuestPrincipal, gameId: string) {
    const snapshot = await readSnapshot(principal, gameId);
    if (snapshot.state !== "completed" && snapshot.state !== "aborted")
      throw new GameRequestError("INVALID_GAME_STATE");
    return snapshot;
  }

  function mutate(principal: GuestPrincipal, command: MoveCommand | LifecycleCommand) {
    return repository.write(async (tx) => {
      if (!(await tx.lockGuest(principal.guestSessionId)))
        throw new GameRequestError("UNAUTHORIZED");
      const stored = await tx.lockGame(command.gameId);
      if (!stored) throw new GameRequestError("NOT_FOUND");
      const restored = await restoreAuthorized(tx, principal, stored);
      const commandId = command.commandId.toLowerCase();
      // Accepted IDs span every command kind, including retries after completion.
      if (command.expectedVersion !== stored.version || (await tx.hasCommand(stored.id, commandId)))
        throw new GameConflictError(restored.snapshot);
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
      const accepted = isMove
        ? restored.game.playMove(command.move)
        : command.action === "resign"
          ? restored.game.resignHuman(command.losingColor)
          : restored.game[command.action]();
      if (!accepted.ok) {
        if (["ILLEGAL_MOVE", "INVALID_UCI", "INVALID_GAME_STATE"].includes(accepted.error.code))
          throw new GameRequestError(
            accepted.error.code as "ILLEGAL_MOVE" | "INVALID_UCI" | "INVALID_GAME_STATE",
          );
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
      if (!(await tx.updatePosition(stored.id, stored.version, positionOf(snapshot))))
        throw new GameIntegrityError();
      return snapshot;
    });
  }

  return {
    sandboxEnabled,
    createSandbox: (principal) =>
      repository.write(async (tx) => {
        if (!sandboxEnabled) throw new GameRequestError("NOT_FOUND");
        if (!(await tx.lockGuest(principal.guestSessionId)))
          throw new GameRequestError("UNAUTHORIZED");
        const occupied = await tx.findUnfinishedGame(principal.guestSessionId);
        if (occupied) {
          const locked = await tx.lockGame(occupied.id);
          if (!locked) throw new GameIntegrityError();
          throw new GameConflictError((await restoreAuthorized(tx, principal, locked)).snapshot);
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
        if (!(await reader.getGuest(principal.guestSessionId)))
          throw new GameRequestError("UNAUTHORIZED");
        const stored = await reader.findUnfinishedGame(principal.guestSessionId, true);
        return {
          snapshot: stored ? (await restoreAuthorized(reader, principal, stored)).snapshot : null,
        };
      }),
  };
}

function transportSnapshot(gameId: string, version: number, snapshot: ChessSnapshot): GameSnapshot {
  const result = gameSnapshotSchema.safeParse({ ...snapshot, gameId, version });
  if (!result.success) throw new GameIntegrityError();
  return result.data;
}

function positionOf(snapshot: GameSnapshot) {
  return {
    state: snapshot.state,
    result: snapshot.result,
    terminationReason: snapshot.terminationReason,
    fen: snapshot.fen,
    pgn: snapshot.pgn,
    version: snapshot.version,
  };
}
