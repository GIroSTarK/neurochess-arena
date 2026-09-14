import { randomUUID } from "node:crypto";

import { type ChessGame, createGame, restoreGame } from "@neurochess/chess";
import {
  type AiGameConfiguration,
  aiGameConfigurationSchema,
  type AiTurnCommand,
  type GameDetails,
  gameLifecycleSchema,
  type GamePgnResponse,
  type GameReplayResponse,
  type GameSnapshot,
  type LifecycleCommand,
  type MoveCommand,
  type UnfinishedGameDetails,
  type UnfinishedGameResponse,
} from "@neurochess/contracts";
import type {
  GameReader,
  GameRepository,
  GameTransaction,
  StoredGame,
  StoredMove,
  StoredParticipant,
} from "@neurochess/database";

import type { GuestPrincipal } from "../guests/service.js";
import type { ListModelsInput } from "../providers/adapter.js";

import { type AiAdapters, createAiTurnExecutor } from "./ai-turn.js";
import { authorizeGameControl, authorizeGameRead, authorizeHumanSeat } from "./authorization.js";
import { persistCommand, positionOf, transportSnapshot } from "./command-persistence.js";
import { configurationOf, participantsFor } from "./configuration.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";

export interface GameService {
  readonly sandboxEnabled: boolean;
  createSandbox(principal: GuestPrincipal): Promise<GameSnapshot>;
  createAi(principal: GuestPrincipal, configuration: unknown): Promise<GameDetails>;
  details(principal: GuestPrincipal, gameId: string): Promise<GameDetails>;
  unfinishedGame(principal: GuestPrincipal): Promise<UnfinishedGameDetails>;
  snapshot(principal: GuestPrincipal, gameId: string): Promise<GameSnapshot>;
  move(principal: GuestPrincipal, command: MoveCommand): Promise<GameSnapshot>;
  aiTurn(
    principal: GuestPrincipal,
    command: unknown,
    access: ListModelsInput,
  ): Promise<GameSnapshot>;
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
  readonly configuration: AiGameConfiguration | null;
}

export function createGameService(
  repository: GameRepository,
  options: {
    readonly nodeEnv: "development" | "test" | "production";
    readonly sandboxEnabled: boolean;
    readonly aiAdapters?: AiAdapters;
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
    const configuration = configurationOf(stored, participants);
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
        replayed?.ply !== move.ply ||
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
    return { game: restored.value, snapshot, moves, participants, configuration };
  }

  function readDetails(principal: GuestPrincipal, gameId: string): Promise<GameDetails> {
    return repository.read(async (reader) => {
      if (!(await reader.getGuest(principal.guestSessionId))) {
        throw new GameRequestError("UNAUTHORIZED");
      }
      const stored = await reader.getGame(gameId);
      if (!stored) throw new GameRequestError("NOT_FOUND");
      const { snapshot, configuration } = await restoreAuthorized(reader, principal, stored);
      return { snapshot, configuration };
    });
  }

  async function readSnapshot(principal: GuestPrincipal, gameId: string): Promise<GameSnapshot> {
    return (await readDetails(principal, gameId)).snapshot;
  }

  async function terminalSnapshot(principal: GuestPrincipal, gameId: string) {
    const snapshot = await readSnapshot(principal, gameId);
    if (snapshot.state !== "completed" && snapshot.state !== "aborted") {
      throw new GameRequestError("INVALID_GAME_STATE");
    }
    return snapshot;
  }

  async function prepareCommand(
    tx: GameTransaction,
    principal: GuestPrincipal,
    command: AiTurnCommand,
  ) {
    if (!(await tx.lockGuest(principal.guestSessionId))) {
      throw new GameRequestError("UNAUTHORIZED");
    }
    const stored = await tx.lockGame(command.gameId);
    if (!stored) throw new GameRequestError("NOT_FOUND");
    const restored = await restoreAuthorized(tx, principal, stored);
    // Accepted IDs span every command kind, including retries after completion.
    if (
      command.expectedVersion !== stored.version ||
      (await tx.hasCommand(stored.id, command.commandId.toLowerCase()))
    ) {
      throw new GameConflictError(restored.snapshot);
    }
    return { ...restored, stored };
  }

  function mutate(principal: GuestPrincipal, command: MoveCommand | LifecycleCommand) {
    return repository.write(async (tx) => {
      const restored = await prepareCommand(tx, principal, command);
      const { stored } = restored;
      const commandId = command.commandId.toLowerCase();
      if (
        stored.mode !== null &&
        (await tx.getAiTurnReservation(stored.id))?.commandId === commandId
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
      const accepted = isMove
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
      return persistCommand(
        tx,
        stored,
        commandId,
        isMove ? "move" : command.action,
        accepted.value,
      );
    });
  }

  function createOwnedGame(
    principal: GuestPrincipal,
    configuration: AiGameConfiguration | null,
  ): Promise<GameDetails> {
    return repository.write(async (tx) => {
      if (configuration === null && !sandboxEnabled) throw new GameRequestError("NOT_FOUND");
      if (!(await tx.lockGuest(principal.guestSessionId))) {
        throw new GameRequestError("UNAUTHORIZED");
      }
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
          isSandbox: configuration === null,
          mode: configuration?.mode ?? null,
          ...positionOf(snapshot),
        },
        participantsFor(snapshot.gameId, principal.guestSessionId, configuration),
      );
      return { snapshot, configuration };
    });
  }

  return {
    sandboxEnabled,
    async createSandbox(principal) {
      return (await createOwnedGame(principal, null)).snapshot;
    },
    async createAi(principal, input) {
      const configuration = aiGameConfigurationSchema.safeParse(input);
      if (!configuration.success) throw new GameRequestError("INVALID_REQUEST");
      return createOwnedGame(principal, configuration.data);
    },
    details: readDetails,
    unfinishedGame: (principal) =>
      repository.read(async (reader) => {
        if (!(await reader.getGuest(principal.guestSessionId))) {
          throw new GameRequestError("UNAUTHORIZED");
        }
        const stored = await reader.findUnfinishedGame(principal.guestSessionId);
        if (!stored) return { game: null };
        const { snapshot, configuration } = await restoreAuthorized(reader, principal, stored);
        return { game: { snapshot, configuration } };
      }),
    snapshot: readSnapshot,
    move: mutate,
    aiTurn: createAiTurnExecutor({
      repository,
      adapters: options.aiAdapters ?? {},
      prepareCommand,
    }),
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
          snapshot: stored ? (await restoreAuthorized(reader, principal, stored)).snapshot : null,
        };
      }),
  };
}
