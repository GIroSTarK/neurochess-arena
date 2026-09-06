import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import {
  type AiConfiguration,
  aiConfigurationSchema,
  type AiTurnCommand,
  type CreateAiGameRequest,
  type GameSnapshot,
  type ModelDescriptor,
  modelDescriptorSchema,
  type NormalizedMoveResponse,
  normalizedMoveResponseSchema,
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
import type { AiProviderAdapter } from "../providers/adapter.js";
import { buildModelContext } from "../providers/context.js";
import { resolveAiConfiguration } from "../providers/normalization.js";

import { assertAiExecutionAttached, withAiLease } from "./ai-lease.js";
import { authorizeGameControl } from "./authorization.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";
import { positionOf, restoreAuthorized, transportSnapshot } from "./state.js";

export interface AiGameOptions {
  /** Trusted server-side model capabilities; never accepted from a client. */
  readonly providers?: readonly {
    readonly adapter: AiProviderAdapter;
    readonly models: readonly ModelDescriptor[];
  }[];
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
  const providers = (options.providers ?? []).map(({ adapter, models }) => {
    const parsed = modelDescriptorSchema.array().safeParse(models);
    if (
      !parsed.success ||
      parsed.data.some((model) => model.provider !== adapter.descriptor.id) ||
      new Set(parsed.data.map((model) => model.id)).size !== parsed.data.length
    ) {
      throw new Error("INVALID_AI_CATALOG");
    }
    return { adapter, models: parsed.data };
  });
  if (new Set(providers.map(({ adapter }) => adapter.descriptor.id)).size !== providers.length) {
    throw new Error("INVALID_AI_CATALOG");
  }

  function providerFor(configuration: AiConfiguration) {
    const provider = providers.find(
      ({ adapter }) => adapter.descriptor.id === configuration.provider,
    );
    if (!provider) throw new GameRequestError("NOT_FOUND");
    return provider;
  }

  function effectiveConfiguration(requested: AiConfiguration): AiConfiguration {
    const model = providerFor(requested).models.find(
      (candidate) => candidate.id === requested.modelId,
    );
    const resolved = model && resolveAiConfiguration(requested, model);
    if (!resolved) throw new GameRequestError("INVALID_REQUEST");
    return resolved;
  }

  async function lockAuthorized(tx: GameTransaction, principal: GuestPrincipal, gameId: string) {
    if (!(await tx.lockGuest(principal.guestSessionId))) throw new GameRequestError("UNAUTHORIZED");
    const stored = await tx.lockGame(gameId);
    if (!stored) throw new GameRequestError("NOT_FOUND");
    const restored = await restoreAuthorized(tx, principal, stored, sandboxEnabled);
    authorizeGameControl(principal, stored);
    return { stored, ...restored };
  }

  async function reserve(principal: GuestPrincipal, command: AiTurnCommand) {
    return repository.write(async (tx) => {
      const restored = await lockAuthorized(tx, principal, command.gameId);
      const { stored, snapshot, game, participants } = restored;
      if (
        command.expectedVersion !== stored.version ||
        (await tx.hasCommand(stored.id, command.commandId))
      ) {
        throw new GameConflictError(snapshot);
      }
      if (stored.state !== "active" || stored.isSandbox || stored.mode === "human_vs_human") {
        throw new GameRequestError("INVALID_GAME_STATE");
      }
      const seat = participants.find((participant) => participant.color === snapshot.turn);
      if (seat?.seatType !== "ai") throw new GameRequestError("FORBIDDEN");
      const configuration = configurationOf(seat);
      const { adapter } = providerFor(configuration);
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
      const context = buildModelContext(game, snapshot.turn);
      const invocation = await tx.beginAiInvocation(owner);
      return { owner, configuration, adapter, context, invocation };
    });
  }

  async function aiTurn(
    principal: GuestPrincipal,
    command: AiTurnCommand,
    attached?: AbortSignal,
  ): Promise<GameSnapshot> {
    try {
      if (attached) assertAiExecutionAttached(attached);
      const reserved = await reserve(principal, command);
      return await withAiLease(repository, reserved.owner, leaseMs, attached, async (signal) => {
        let invocation = reserved.invocation;
        for (;;) {
          assertAiExecutionAttached(signal);
          // Mock-only composition needs no credential; HTTP key transport is not enabled.
          const response = await reserved.adapter.requestMove({
            apiKey: "",
            configuration: structuredClone(reserved.configuration),
            context: structuredClone(reserved.context),
            signal,
          });
          assertAiExecutionAttached(signal);
          const parsed = normalizedMoveResponseSchema.safeParse(response);
          if (!parsed.success) throw new GameIntegrityError();
          const accepted = await repository.write(async (tx) => {
            const current = await lockAuthorized(tx, principal, command.gameId);
            if (
              current.stored.version !== command.expectedVersion ||
              current.snapshot.turn !== reserved.context.color
            ) {
              throw new GameConflictError(current.snapshot);
            }
            assertAiExecutionAttached(signal);
            let outcome: NormalizedMoveResponse = parsed.data;
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
            if (!outcome.ok && outcome.error.kind === "model_invalid" && invocation.attempt < 3) {
              return null;
            }
            const result = outcome.ok
              ? move
              : outcome.error.kind === "model_invalid"
                ? current.game.recordTechnicalLoss(reserved.context.color)
                : current.game.pause();
            if (!result?.ok) throw new GameIntegrityError();
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
          const configuration = effectiveConfiguration(
            request.mode === "ai_vs_ai" ? request[color] : request.ai,
          );
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
