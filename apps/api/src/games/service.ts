import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import {
  type AiGameConfiguration,
  aiGameConfigurationSchema,
  type AiProvider,
  type GameDetails,
  type GameHistoryDeletedResponse,
  type GameHistoryQuery,
  type GameHistoryResponse,
  type GameInvocations,
  type GamePgnResponse,
  type GameReplayResponse,
  type GameSnapshot,
  isAiGameMode,
  type LifecycleCommand,
  type ModelDiscoveryResult,
  type MoveCommand,
  type UnfinishedGameDetails,
  type UnfinishedGameResponse,
} from "@neurochess/contracts";
import type { GameRepository, IdentityTransaction, StoredGame } from "@neurochess/database";

import type { CredentialCipher } from "../credentials/crypto.js";
import {
  createProviderCredentialAccess,
  credentialFailure,
  type ProviderOperationAccess,
} from "../credentials/provider-access.js";
import type { GameIdentity, Principal } from "../identity/principal.js";
import { lockPrincipal, requireActivePrincipal } from "../identity/validity.js";
import type { Operations } from "../monitoring/operations.js";
import { discoverModels } from "../providers/discovery.js";
import type { RoomEvents } from "../realtime/room-events.js";

import { type AiAdapters, createAiTurnExecutor } from "./ai-turn.js";
import { authorizeGameControl, authorizeHumanSeat } from "./authorization.js";
import { persistCommand, positionOf, transportSnapshot } from "./command-persistence.js";
import { prepareGameCommand } from "./command-preparation.js";
import { participantsFor } from "./configuration.js";
import { CONTROLLER_LEASE_MS, requireController } from "./controller-presence.js";
import { createControllerService } from "./controller-service.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";
import { createHistoryReader } from "./history.js";
import { createHistoryDeletion } from "./history-deletion.js";
import { readInvocations } from "./invocations.js";
import { type GameRestorationReader, restoreAuthorizedGame } from "./restoration.js";

export interface GameService {
  cleanupSharedRooms(): Promise<void>;
  deleteGame(
    principal: Principal,
    input: unknown,
    onCleanupFailure?: () => void,
  ): Promise<GameHistoryDeletedResponse>;
  clearHistory(
    principal: Principal,
    input: unknown,
    onCleanupFailure?: () => void,
  ): Promise<GameHistoryDeletedResponse>;
  history(principal: Principal, query: GameHistoryQuery): Promise<GameHistoryResponse>;
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

export function createGameService(
  repository: Pick<
    GameRepository,
    "read" | "write" | "expiredAiControllers" | "cleanupSharedRooms"
  >,
  options: {
    readonly nodeEnv: "development" | "test" | "production";
    readonly sandboxEnabled: boolean;
    readonly aiAdapters?: AiAdapters;
    readonly controllerLeaseMs?: number;
    readonly credentialCipher?: Pick<CredentialCipher, "decrypt">;
    readonly roomEvents?: RoomEvents;
    readonly operations?: Operations;
  },
): GameService {
  const sandboxEnabled = options.sandboxEnabled && options.nodeEnv !== "production";
  const adapters = { ...options.aiAdapters };
  const leaseMs = options.controllerLeaseMs ?? CONTROLLER_LEASE_MS;
  const useCredential = createProviderCredentialAccess(repository, options.credentialCipher);

  const restoreAuthorized = (
    reader: GameRestorationReader,
    principal: GameIdentity,
    stored: StoredGame,
  ) => restoreAuthorizedGame(reader, principal, stored, sandboxEnabled);

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

  async function mutate(principal: Principal, command: MoveCommand | LifecycleCommand) {
    const result = await repository.write(async (tx) => {
      const restored = await prepareGameCommand(tx, principal, command, {
        sandboxEnabled,
        allowRoomCommands: true,
      });
      const { stored } = restored;
      const commandId = command.commandId.toLowerCase();
      if (
        isAiGameMode(stored.mode) &&
        (await tx.getAiTurnReservation(stored.id))?.commandId === commandId
      ) {
        throw new GameConflictError(restored.snapshot);
      }
      const isMove = "move" in command;
      if (stored.mode === "human_vs_human" && !isMove) {
        if (command.action === "pause" || command.action === "resume") {
          throw new GameRequestError("FORBIDDEN");
        }
        if (command.action === "resign" && stored.state !== "active") {
          throw new GameRequestError("INVALID_GAME_STATE");
        }
      }
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
      if (!isMove && isAiGameMode(stored.mode) && command.action !== "resign") {
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
          : command.action === "pause" && isAiGameMode(stored.mode) && stored.state === "paused"
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
      const snapshot = await persistCommand(
        tx,
        stored,
        commandId,
        isMove ? "move" : command.action,
        accepted.value,
      );
      await requireActivePrincipal(tx, principal);
      return { snapshot, roomChanged: stored.mode === "human_vs_human" };
    });
    if (result.roomChanged) options.roomEvents?.publish(result.snapshot.gameId);
    return result.snapshot;
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
      await requireActivePrincipal(tx, principal);
      return { snapshot, configuration };
    });
  }

  return {
    ...createHistoryDeletion(repository, options.roomEvents),
    cleanupSharedRooms: () => repository.cleanupSharedRooms(),
    history: createHistoryReader(repository),
    isSandboxGame: (gameId) =>
      repository.read(async (reader) => (await reader.getGame(gameId))?.isSandbox === true),
    ...createControllerService(repository, { sandboxEnabled, controllerLeaseMs: leaseMs }),
    sandboxEnabled,
    async models(principal, provider, access) {
      const adapter = adapters[provider];
      const authorize = async (tx: IdentityTransaction) => {
        if (!(await lockPrincipal(tx, principal))) throw new GameRequestError("UNAUTHORIZED");
      };
      const result = await useCredential(principal, provider, access, authorize, (resolved) =>
        discoverModels(
          adapter?.provider === provider ? adapter : undefined,
          resolved,
          options.operations,
        ),
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
        if (stored.mode === "human_vs_human") throw new GameRequestError("FORBIDDEN");
        return readInvocations(reader, snapshot);
      }),
    move: mutate,
    aiTurn: createAiTurnExecutor({
      ...(options.operations ? { operations: options.operations } : {}),
      repository,
      adapters,
      prepareCommand: (tx, principal, command) =>
        prepareGameCommand(tx, principal, command, { sandboxEnabled, allowRoomCommands: false }),
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
