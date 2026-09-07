import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import {
  type AiConfiguration,
  aiConfigurationSchema,
  type AiTurnCommand,
  type CreateAiGameRequest,
  type GameSnapshot,
  type NormalizedMoveResponse,
  type SessionCredential,
  type UnfinishedGameResponse,
} from "@neurochess/contracts";
import {
  AiPersistenceError,
  type AiReservationOwner,
  type GameRepository,
  type GameTransaction,
  type NewParticipant,
  type StoredParticipant,
} from "@neurochess/database";

import type { GuestPrincipal } from "../guests/service.js";
import { buildModelContext } from "../providers/context.js";
import {
  createProviderRegistry,
  type ProviderRegistration,
  validateCredential,
} from "../providers/registry.js";

import { assertAiExecutionAttached, withAiLease } from "./ai-lease.js";
import { authorizeGameControl } from "./authorization.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";
import { positionOf, restoreAuthorized, transportSnapshot } from "./state.js";

export interface AiGameOptions {
  readonly providers?: readonly ProviderRegistration[];
  readonly leaseMs?: number;
}

export function createAiGameOperations(
  repository: GameRepository,
  sandboxEnabled: boolean,
  options: AiGameOptions = {},
) {
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
    throw new Error("INVALID_AI_LEASE");
  }
  const providers = createProviderRegistry(options.providers);

  async function requireGuest(principal: GuestPrincipal) {
    await repository.read(async (reader) => {
      if (!(await reader.getGuest(principal.guestSessionId))) {
        throw new GameRequestError("UNAUTHORIZED");
      }
    });
  }

  async function lockAuthorized(tx: GameTransaction, principal: GuestPrincipal, gameId: string) {
    if (!(await tx.lockGuest(principal.guestSessionId))) throw new GameRequestError("UNAUTHORIZED");
    const stored = await tx.lockGame(gameId);
    if (!stored) throw new GameRequestError("NOT_FOUND");
    const restored = await restoreAuthorized(tx, principal, stored, sandboxEnabled);
    authorizeGameControl(principal, stored);
    return { stored, ...restored };
  }

  async function reserve(
    principal: GuestPrincipal,
    command: AiTurnCommand,
    provider: SessionCredential["provider"],
  ) {
    return repository.write(async (tx) => {
      const restored = await lockAuthorized(tx, principal, command.gameId);
      const { stored, snapshot, game, participants } = restored;
      if (
        command.expectedVersion !== stored.version ||
        (await tx.hasCommand(stored.id, command.commandId))
      ) {
        throw new GameConflictError(snapshot);
      }
      if (
        (stored.state !== "active" && stored.state !== "paused") ||
        stored.isSandbox ||
        stored.mode === "human_vs_human"
      ) {
        throw new GameRequestError("INVALID_GAME_STATE");
      }
      const seat = participants.find((participant) => participant.color === snapshot.turn);
      if (seat?.seatType !== "ai") throw new GameRequestError("FORBIDDEN");
      const configuration = configurationOf(seat);
      if (provider !== configuration.provider) throw new GameRequestError("INVALID_REQUEST");
      providers.has(configuration.provider);
      const executorId = randomUUID();
      const result = await tx.reserveAiTurn({
        gameId: stored.id,
        ownerGuestSessionId: principal.guestSessionId,
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        color: snapshot.turn,
        executorId,
        leaseMs,
      });
      if (result.status !== "reserved") throw new GameConflictError(snapshot);
      const owner: AiReservationOwner = {
        gameId: stored.id,
        ownerGuestSessionId: principal.guestSessionId,
        reservationId: result.reservation.id,
        executorId,
      };
      // A paused step activates only this private aggregate; persistence stays paused throughout I/O.
      if (stored.state === "paused" && !game.resume().ok) throw new GameIntegrityError();
      const context = buildModelContext(game, snapshot.turn);
      const invocation = await tx.beginAiInvocation(owner);
      return { owner, configuration, context, invocation };
    });
  }

  async function aiTurn(
    principal: GuestPrincipal,
    command: AiTurnCommand,
    credential: SessionCredential,
    attached?: AbortSignal,
  ): Promise<GameSnapshot> {
    try {
      validateCredential(credential);
      if (attached) assertAiExecutionAttached(attached);
      const reserved = await reserve(principal, command, credential.provider);
      return await withAiLease(repository, reserved.owner, leaseMs, attached, async (signal) => {
        let invocation = reserved.invocation;
        for (;;) {
          assertAiExecutionAttached(signal);
          const response = await providers.requestMove(credential, {
            configuration: structuredClone(reserved.configuration),
            context: structuredClone(reserved.context),
            signal,
          });
          assertAiExecutionAttached(signal);
          const accepted = await repository.write(async (tx) => {
            const current = await lockAuthorized(tx, principal, command.gameId);
            if (
              current.stored.version !== command.expectedVersion ||
              current.snapshot.turn !== reserved.context.color
            ) {
              throw new GameConflictError(current.snapshot);
            }
            assertAiExecutionAttached(signal);
            const stepping = current.stored.state === "paused";
            if (stepping && !current.game.resume().ok) throw new GameIntegrityError();
            let outcome: NormalizedMoveResponse = response;
            const move = outcome.ok ? current.game.playMove(outcome.value.move) : undefined;
            if (move && !move.ok) {
              if (move.error.code !== "ILLEGAL_MOVE" && move.error.code !== "INVALID_UCI") {
                throw new GameIntegrityError();
              }
              if (!outcome.ok) throw new GameIntegrityError();
              outcome = {
                ok: false,
                error: { kind: "model_invalid", reason: "illegal_move" },
                latencyMs: outcome.value.latencyMs,
                usage: outcome.value.usage,
                ...(outcome.value.providerRequestId === undefined
                  ? {}
                  : { providerRequestId: outcome.value.providerRequestId }),
              };
            }
            await tx.recordAiInvocation(reserved.owner, invocation.id, outcome);
            if (
              !outcome.ok &&
              outcome.error.kind === "model_invalid" &&
              (await tx.countAiInvalidOutputs(reserved.owner)) < 3
            ) {
              return null;
            }
            let result = outcome.ok
              ? move
              : outcome.error.kind === "model_invalid"
                ? current.game.recordTechnicalLoss(reserved.context.color)
                : current.game.pause();
            if (!result?.ok) throw new GameIntegrityError();
            if (stepping && result.value.state === "active") {
              result = current.game.pause();
              if (!result.ok) throw new GameIntegrityError();
            }
            const snapshot = transportSnapshot(
              current.stored.id,
              current.stored.version + 1,
              result.value,
            );
            const acceptedMove = outcome.ok ? snapshot.moves.at(-1) : undefined;
            if (outcome.ok && !acceptedMove) throw new GameIntegrityError();
            assertAiExecutionAttached(signal);
            await tx.commitAiTurn(reserved.owner, {
              position: positionOf(snapshot),
              ...(acceptedMove ? { move: acceptedMove } : {}),
            });
            return snapshot;
          });
          if (accepted) return accepted;
          assertAiExecutionAttached(signal);
          invocation = await repository.write((tx) => tx.beginAiInvocation(reserved.owner));
        }
      });
    } catch (error) {
      if (error instanceof AiPersistenceError) {
        if (error.code === "RESERVATION_LOST") {
          return repository.read(async (reader) => {
            if (!(await reader.getGuest(principal.guestSessionId))) {
              throw new GameRequestError("UNAUTHORIZED");
            }
            const stored = await reader.getGame(command.gameId);
            if (!stored) throw new GameRequestError("NOT_FOUND");
            const restored = await restoreAuthorized(reader, principal, stored, sandboxEnabled);
            throw new GameConflictError(restored.snapshot);
          });
        }
        if (error.code === "UNAUTHORIZED" || error.code === "NOT_FOUND") {
          throw new GameRequestError(error.code);
        }
        if (error.code === "INVALID_AI_STATE") throw new GameRequestError("INVALID_GAME_STATE");
      }
      if (error instanceof GameRequestError || error instanceof GameConflictError) throw error;
      // Never let unexpected adapter errors (including secret-bearing objects) escape this boundary.
      throw new GameIntegrityError();
    }
  }

  return {
    aiTurn,
    listProviders: async (principal: GuestPrincipal) => {
      await requireGuest(principal);
      return providers.list();
    },
    discoverModels: async (
      principal: GuestPrincipal,
      credential: SessionCredential,
      signal?: AbortSignal,
      catalogId?: string,
    ) => {
      await requireGuest(principal);
      const result = await providers.discover(
        principal.guestSessionId,
        credential,
        signal,
        catalogId,
      );
      await requireGuest(principal);
      return result;
    },
    createAi: (principal: GuestPrincipal, request: CreateAiGameRequest): Promise<GameSnapshot> =>
      repository.write(async (tx) => {
        if (!(await tx.lockGuest(principal.guestSessionId))) {
          throw new GameRequestError("UNAUTHORIZED");
        }
        const occupied = await tx.findUnfinishedGame(principal.guestSessionId);
        if (occupied) {
          const restored = await lockAuthorized(tx, principal, occupied.id);
          throw new GameConflictError(restored.snapshot);
        }
        const initial = createGame().start();
        if (!initial.ok) throw new GameIntegrityError();
        const snapshot = transportSnapshot(randomUUID(), 0, initial.value);
        const participants: NewParticipant[] = (["white", "black"] as const).map((color) => {
          const base = { gameId: snapshot.gameId, color };
          if (request.mode === "ai_vs_human" && request.humanColor === color) {
            return { ...base, seatType: "human", guestSessionId: principal.guestSessionId };
          }
          const { catalogId, ...requested } =
            request.mode === "ai_vs_ai" ? request[color] : request.ai;
          const configuration = providers.resolve(principal.guestSessionId, requested, catalogId);
          return {
            ...base,
            seatType: "ai",
            provider: configuration.provider,
            modelId: configuration.modelId,
            ...configuration.parameters,
          };
        });
        await tx.insertGame(
          {
            id: snapshot.gameId,
            ownerGuestSessionId: principal.guestSessionId,
            mode: request.mode,
            isSandbox: false,
            ...positionOf(snapshot),
          },
          participants,
        );
        return snapshot;
      }),
    unfinishedAi: (principal: GuestPrincipal): Promise<UnfinishedGameResponse> =>
      repository.read(async (reader) => {
        if (!(await reader.getGuest(principal.guestSessionId))) {
          throw new GameRequestError("UNAUTHORIZED");
        }
        const stored = await reader.findUnfinishedGame(principal.guestSessionId);
        return {
          snapshot:
            stored && !stored.isSandbox && stored.mode !== "human_vs_human"
              ? (await restoreAuthorized(reader, principal, stored, sandboxEnabled)).snapshot
              : null,
        };
      }),
  };
}

function configurationOf(seat: StoredParticipant): AiConfiguration {
  const parsed = aiConfigurationSchema.safeParse({
    provider: seat.provider,
    modelId: seat.modelId,
    parameters: {
      ...(seat.temperature === null ? {} : { temperature: seat.temperature }),
      ...(seat.reasoningEffort === null ? {} : { reasoningEffort: seat.reasoningEffort }),
      ...(seat.maxOutputTokens === null ? {} : { maxOutputTokens: seat.maxOutputTokens }),
    },
  });
  if (!parsed.success) throw new GameIntegrityError();
  return parsed.data;
}
