import { randomUUID } from "node:crypto";

import { type ChessGame, createGame, restoreGame } from "@neurochess/chess";
import {
  aiControllerRequestSchema,
  type AiGameConfiguration,
  aiGameConfigurationSchema,
  type AiProvider,
  type AiTurnCommand,
  type GameDetails,
  type GameInvocations,
  gameLifecycleSchema,
  type GamePgnResponse,
  type GameReplayResponse,
  type GameSnapshot,
  type LifecycleCommand,
  type ModelDiscoveryResult,
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

import type { CredentialCipher } from "../credentials/crypto.js";
import {
  createProviderCredentialAccess,
  credentialFailure,
  type ProviderOperationAccess,
} from "../credentials/provider-access.js";
import type { GameIdentity, Principal } from "../identity/principal.js";
import { lockIdentity, lockPrincipal, requireActivePrincipal } from "../identity/validity.js";
import { discoverModels } from "../providers/discovery.js";

import { type AiAdapters, AiTurnError, createAiTurnExecutor } from "./ai-turn.js";
import {
  authorizeGameControl,
  authorizeGameRead,
  authorizeHumanSeat,
  ownerOf,
} from "./authorization.js";
import { persistCommand, positionOf, transportSnapshot } from "./command-persistence.js";
import { configurationOf, participantsFor } from "./configuration.js";
import { CONTROLLER_LEASE_MS, requireController } from "./controller-presence.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";
import { readInvocations } from "./invocations.js";

export interface GameService {
  isSandboxGame(gameId: string): Promise<boolean>;
  controller(principal: Principal, input: unknown): Promise<GameSnapshot>;
  expireControllers(): Promise<void>;
  readonly sandboxEnabled: boolean;
  models(
    principal: Principal,
    provider: AiProvider,
    access: ProviderOperationAccess,
  ): Promise<ModelDiscoveryResult>;
  createSandbox(principal: Principal): Promise<GameSnapshot>;
  createAi(principal: Principal, configuration: unknown): Promise<GameDetails>;
  details(principal: Principal, gameId: string): Promise<GameDetails>;
  invocations(principal: Principal, gameId: string): Promise<GameInvocations>;
  unfinishedGame(principal: Principal): Promise<UnfinishedGameDetails>;
  snapshot(principal: Principal, gameId: string): Promise<GameSnapshot>;
  move(principal: Principal, command: MoveCommand): Promise<GameSnapshot>;
  aiTurn(
    principal: Principal,
    command: unknown,
    access: ProviderOperationAccess,
  ): Promise<GameSnapshot>;
  lifecycle(principal: Principal, command: LifecycleCommand): Promise<GameSnapshot>;
  unfinished(principal: Principal): Promise<UnfinishedGameResponse>;
  replay(principal: Principal, gameId: string): Promise<GameReplayResponse>;
  pgn(principal: Principal, gameId: string): Promise<GamePgnResponse>;
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
    readonly controllerLeaseMs?: number;
    readonly credentialCipher?: Pick<CredentialCipher, "decrypt">;
  },
): GameService {
  const sandboxEnabled = options.sandboxEnabled && options.nodeEnv !== "production";
  const adapters = { ...options.aiAdapters };
  const leaseMs = options.controllerLeaseMs ?? CONTROLLER_LEASE_MS;
  const useCredential = createProviderCredentialAccess(repository, options.credentialCipher);

  async function restoreAuthorized(
    reader: GameReader,
    principal: GameIdentity,
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

  function readDetails(principal: Principal, gameId: string): Promise<GameDetails> {
    return repository.read(async (reader) => {
      await requireActivePrincipal(reader, principal);
      const stored = await reader.getGame(gameId);
      if (!stored) throw new GameRequestError("NOT_FOUND");
      const { snapshot, configuration } = await restoreAuthorized(reader, principal, stored);
      return { snapshot, configuration };
    });
  }

  async function readSnapshot(principal: Principal, gameId: string): Promise<GameSnapshot> {
    return (await readDetails(principal, gameId)).snapshot;
  }

  async function terminalSnapshot(principal: Principal, gameId: string) {
    const snapshot = await readSnapshot(principal, gameId);
    if (snapshot.state !== "completed" && snapshot.state !== "aborted") {
      throw new GameRequestError("INVALID_GAME_STATE");
    }
    return snapshot;
  }

  async function prepareCommand(tx: GameTransaction, principal: Principal, command: AiTurnCommand) {
    if (!(await lockPrincipal(tx, principal))) {
      throw new GameRequestError("UNAUTHORIZED");
    }
    const stored = await tx.lockGame(command.gameId);
    await requireActivePrincipal(tx, principal);
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

  function mutate(principal: Principal, command: MoveCommand | LifecycleCommand) {
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
      if (!isMove && stored.mode !== null && command.action !== "resign") {
        if (command.action === "resume") {
          await requireController(tx, stored.id, command.controllerId);
        } else if (command.action === "pause" && !command.controllerId) {
          await tx.clearAiController(stored.id);
        }
      }
      const accepted = isMove
        ? restored.game.playMove(command.move)
        : command.action === "resign"
          ? restored.game.resignHuman(command.losingColor)
          : command.action === "pause" && stored.mode !== null && stored.state === "paused"
            ? { ok: true as const, value: restored.game.snapshot() }
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
    principal: Principal,
    configuration: AiGameConfiguration | null,
  ): Promise<GameDetails> {
    return repository.write(async (tx) => {
      if (configuration === null && (!sandboxEnabled || principal.kind !== "guest")) {
        throw new GameRequestError("NOT_FOUND");
      }
      if (!(await lockPrincipal(tx, principal))) {
        throw new GameRequestError("UNAUTHORIZED");
      }
      const occupied =
        principal.kind === "account"
          ? await tx.findUnfinishedAccountGame(principal.userId)
          : await tx.findUnfinishedGame(
              principal.guestSessionId,
              configuration === null ? "sandbox" : "ordinary",
            );
      if (occupied) {
        const locked = await tx.lockGame(occupied.id);
        await requireActivePrincipal(tx, principal);
        if (!locked) throw new GameIntegrityError();
        throw new GameConflictError((await restoreAuthorized(tx, principal, locked)).snapshot);
      }
      const started = createGame().start();
      if (!started.ok) throw new GameIntegrityError();
      const snapshot = transportSnapshot(randomUUID(), 0, started.value);
      await tx.insertGame(
        {
          id: snapshot.gameId,
          ownerGuestSessionId: principal.kind === "guest" ? principal.guestSessionId : null,
          ownerUserId: principal.kind === "account" ? principal.userId : null,
          isSandbox: configuration === null,
          mode: configuration?.mode ?? null,
          ...positionOf(snapshot),
        },
        participantsFor(snapshot.gameId, principal, configuration),
      );
      if (configuration) await tx.setAiController(snapshot.gameId, null, leaseMs);
      return { snapshot, configuration };
    });
  }

  return {
    isSandboxGame: (gameId) =>
      repository.read(async (reader) => (await reader.getGame(gameId))?.isSandbox === true),
    async controller(principal, input) {
      const parsed = aiControllerRequestSchema.safeParse(input);
      if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
      const command = parsed.data;
      return repository.write(async (tx) => {
        if (!(await lockPrincipal(tx, principal))) {
          throw new GameRequestError("UNAUTHORIZED");
        }
        const stored = await tx.lockGame(command.gameId);
        await requireActivePrincipal(tx, principal);
        if (!stored) throw new GameRequestError("NOT_FOUND");
        const { snapshot } = await restoreAuthorized(tx, principal, stored);
        authorizeGameControl(principal, stored);
        if (stored.mode === null) throw new GameRequestError("FORBIDDEN");
        if (stored.state !== "active" && stored.state !== "paused") {
          throw new GameConflictError(snapshot);
        }
        const controllerId = command.controllerId.toLowerCase();
        if (command.action === "heartbeat") {
          if (!(await tx.renewAiController(stored.id, controllerId, leaseMs))) {
            throw new AiTurnError("AI_CONTROLLER_LOST");
          }
        } else {
          if (command.expectedVersion !== stored.version) throw new GameConflictError(snapshot);
          const lease = await tx.getAiController(stored.id);
          if (
            lease &&
            !lease.expired &&
            lease.controllerId &&
            lease.controllerId !== controllerId
          ) {
            throw new AiTurnError("AI_CONTROLLER_BUSY");
          }
          const initial = stored.version === 0 && lease?.controllerId === null && !lease.expired;
          const current = lease?.controllerId === controllerId && !lease.expired;
          if (stored.state === "active" && !initial && !current) {
            throw new AiTurnError("AI_CONTROLLER_LOST");
          }
          // Reclaiming a paused expired lease must first invalidate any uncertain step.
          if (!current && (await tx.getAiTurnReservation(stored.id))) {
            throw new AiTurnError("AI_TURN_RECOVERY_REQUIRED");
          }
          await tx.setAiController(stored.id, controllerId, leaseMs);
        }
        return snapshot;
      });
    },
    async expireControllers() {
      for (const candidate of await repository.expiredAiControllers()) {
        await repository.write(async (tx) => {
          const owner = ownerOf(candidate);
          // System cleanup locks the stored owner even after session expiry.
          await lockIdentity(tx, owner);
          const stored = await tx.lockGame(candidate.gameId);
          if (!stored?.mode) return;
          const lease = await tx.getAiController(stored.id);
          if (lease?.expired === false) return;
          if (
            stored.state === "active" ||
            (stored.state === "paused" && (await tx.getAiTurnReservation(stored.id)))
          ) {
            const { game } = await restoreAuthorized(tx, owner, stored);
            const paused =
              stored.state === "active"
                ? game.pause()
                : { ok: true as const, value: game.snapshot() };
            if (!paused.ok) throw new GameIntegrityError();
            await persistCommand(tx, stored, randomUUID(), "pause", paused.value);
          }
          await tx.clearAiController(stored.id);
        });
      }
    },
    sandboxEnabled,
    async models(principal, provider, access) {
      const adapter = adapters[provider];
      const authorize = async (tx: GameTransaction) => {
        if (!(await lockPrincipal(tx, principal))) throw new GameRequestError("UNAUTHORIZED");
      };
      const result = await useCredential(principal, provider, access, authorize, (resolved) =>
        discoverModels(adapter?.provider === provider ? adapter : undefined, resolved),
      );
      await repository.write(authorize);
      return result ?? credentialFailure;
    },
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
        await requireActivePrincipal(reader, principal);
        const stored =
          principal.kind === "account"
            ? await reader.findUnfinishedAccountGame(principal.userId)
            : await reader.findUnfinishedGame(principal.guestSessionId, "ordinary");
        if (!stored) return { game: null };
        const { snapshot, configuration } = await restoreAuthorized(reader, principal, stored);
        return { game: { snapshot, configuration } };
      }),
    snapshot: readSnapshot,
    invocations: (principal, gameId) =>
      repository.read(async (reader) => {
        await requireActivePrincipal(reader, principal);
        const stored = await reader.getGame(gameId);
        if (!stored) throw new GameRequestError("NOT_FOUND");
        const { snapshot } = await restoreAuthorized(reader, principal, stored);
        return readInvocations(reader, snapshot);
      }),
    move: mutate,
    aiTurn: createAiTurnExecutor({
      repository,
      adapters,
      prepareCommand,
      useCredential,
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
        if (!sandboxEnabled || principal.kind !== "guest") throw new GameRequestError("NOT_FOUND");
        await requireActivePrincipal(reader, principal);
        const stored = await reader.findUnfinishedGame(principal.guestSessionId, "sandbox");
        return {
          snapshot: stored ? (await restoreAuthorized(reader, principal, stored)).snapshot : null,
        };
      }),
  };
}
