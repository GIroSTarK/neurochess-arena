import {
  type AiControlledTurnCommand,
  type AiControllerRequest,
  aiControllerRequestSchema,
  aiErrorResponseSchema,
  type AiGameConfiguration,
  aiGameConfigurationSchema,
  type AiRequestErrorCode,
  aiTurnRequestSchema,
  type GameDetails,
  gameDetailsSchema,
  type GameInvocations,
  gameInvocationsSchema,
  gameParamsSchema,
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  guestSessionResponseSchema,
  lifecycleCommandSchema,
  type ModelDiscoveryRequest,
  modelDiscoveryRequestSchema,
  type ModelDiscoveryResult,
  modelDiscoveryResultSchema,
  moveCommandSchema,
  type ProviderCredentialSource,
  unfinishedGameDetailsSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

import { parsePosition } from "../position/position";

import type { SandboxApi } from "./client";
import { ApiFailure } from "./failures";

export class AiRequestFailure extends Error {
  constructor(readonly code: AiRequestErrorCode | "AI_KEY_REQUIRED") {
    super(code);
    this.name = "AiRequestFailure";
  }
}

export interface AiApi extends Pick<
  SandboxApi,
  "bootstrap" | "snapshot" | "move" | "lifecycle" | "replay" | "pgn"
> {
  discover(input: ModelDiscoveryRequest, signal: AbortSignal): Promise<ModelDiscoveryResult>;
  create(configuration: AiGameConfiguration, signal: AbortSignal): Promise<GameDetails>;
  details(gameId: string, signal: AbortSignal): Promise<GameDetails>;
  unfinished(signal: AbortSignal): Promise<GameDetails | null>;
  invocations(gameId: string, signal: AbortSignal): Promise<GameInvocations>;
  controller(command: AiControllerRequest, signal: AbortSignal): Promise<GameSnapshot>;
  turn(
    command: AiControlledTurnCommand,
    credential: ProviderCredentialSource,
    signal: AbortSignal,
  ): Promise<GameSnapshot>;
}

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiFailure("malformed");
  return result.data;
}

function snapshotFor(snapshot: GameSnapshot, gameId?: string): GameSnapshot {
  if (
    parsePosition(snapshot.fen)?.turn !== snapshot.turn ||
    (gameId !== undefined && snapshot.gameId !== gameId.toLowerCase())
  ) {
    throw new ApiFailure("malformed");
  }
  return snapshot;
}

export interface AiIdentity {
  readonly intent: "account" | "guest";
  readonly expectedAccount?: string;
  readonly signal: AbortSignal;
  verify(): Promise<void>;
  lost?(): void;
}

export function createAiApi(
  apiBaseUrl: string,
  options: { fetch?: typeof fetch; identity?: AiIdentity } = {},
): AiApi {
  const origin = new URL(apiBaseUrl);
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && origin.hostname === "localhost")
  ) {
    throw new ApiFailure("malformed");
  }
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new ApiFailure("malformed");
  }
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
    timeoutMs = 10_000,
    gameId?: string,
  ): Promise<T> {
    const isCancelled = () => signal.aborted || Boolean(options.identity?.signal.aborted);
    if (isCancelled()) throw new ApiFailure("cancelled");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    options.identity?.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    try {
      if (options.identity) await options.identity.verify();
      if (isCancelled()) throw new ApiFailure("cancelled");
      const response = await fetcher(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          "x-neurochess-identity": options.identity?.intent ?? "guest",
          ...(options.identity?.expectedAccount
            ? { "x-neurochess-expected-account": options.identity.expectedAccount }
            : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ApiFailure("malformed");
      }
      if (!response.ok) {
        const error = validated(aiErrorResponseSchema, payload);
        if (error.code === "UNAUTHORIZED" || error.code === "PROFILE_REQUIRED") {
          options.identity?.lost?.();
        }
        if (!("message" in error)) throw new AiRequestFailure(error.code);
        throw new ApiFailure(
          "api",
          error.code,
          error.code === "GAME_CONFLICT" ? snapshotFor(error.currentSnapshot, gameId) : undefined,
        );
      }
      if (options.identity) await options.identity.verify();
      if (isCancelled()) throw new ApiFailure("cancelled");
      return validated(schema, payload);
    } catch (error: unknown) {
      if (isCancelled()) throw new ApiFailure("cancelled");
      if (controller.signal.aborted) throw new ApiFailure("timeout");
      if (error instanceof ApiFailure || error instanceof AiRequestFailure) throw error;
      throw new ApiFailure("network");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      options.identity?.signal.removeEventListener("abort", cancel);
    }
  }

  function gamePath(gameId: string) {
    return "/games/" + validated(gameParamsSchema, { gameId }).gameId.toLowerCase();
  }
  function detailsFor(details: GameDetails, gameId?: string) {
    snapshotFor(details.snapshot, gameId);
    return details;
  }

  return {
    async bootstrap(signal) {
      if (options.identity?.intent === "account") {
        await options.identity.verify();
        if (signal.aborted || options.identity.signal.aborted) throw new ApiFailure("cancelled");
        return;
      }
      await request("/guest-session", guestSessionResponseSchema, signal, {});
    },
    async snapshot(gameId, signal) {
      return snapshotFor(
        await request(gamePath(gameId), gameSnapshotSchema, signal, undefined, 10_000, gameId),
        gameId,
      );
    },
    async move(command, signal) {
      return snapshotFor(
        await request(
          gamePath(command.gameId) + "/moves",
          gameSnapshotSchema,
          signal,
          validated(moveCommandSchema, command),
          10_000,
          command.gameId,
        ),
        command.gameId,
      );
    },
    async lifecycle(command, signal) {
      return snapshotFor(
        await request(
          gamePath(command.gameId) + "/lifecycle",
          gameSnapshotSchema,
          signal,
          validated(lifecycleCommandSchema, command),
          10_000,
          command.gameId,
        ),
        command.gameId,
      );
    },
    async controller(command, signal) {
      return snapshotFor(
        await request(
          gamePath(command.gameId) + "/controller",
          gameSnapshotSchema,
          signal,
          validated(aiControllerRequestSchema, command),
          10_000,
          command.gameId,
        ),
        command.gameId,
      );
    },
    async replay(gameId, signal) {
      const replay = await request(
        gamePath(gameId) + "/replay",
        gameReplayResponseSchema,
        signal,
        undefined,
        10_000,
        gameId,
      );
      snapshotFor(replay.snapshot, gameId);
      if (
        !parsePosition(replay.initialFen) ||
        replay.snapshot.moves.some((move) => !parsePosition(move.fen))
      ) {
        throw new ApiFailure("malformed");
      }
      return replay;
    },
    async pgn(gameId, signal) {
      const result = await request(
        gamePath(gameId) + "/pgn",
        gamePgnResponseSchema,
        signal,
        undefined,
        10_000,
        gameId,
      );
      if (result.gameId !== gameId.toLowerCase()) throw new ApiFailure("malformed");
      return result;
    },
    discover: async (input, signal) =>
      request(
        "/providers/models",
        modelDiscoveryResultSchema,
        signal,
        validated(modelDiscoveryRequestSchema, input),
        35_000,
      ),
    async create(configuration, signal) {
      return detailsFor(
        await request(
          "/games",
          gameDetailsSchema,
          signal,
          validated(aiGameConfigurationSchema, configuration),
        ),
      );
    },
    async details(gameId, signal) {
      return detailsFor(
        await request(
          gamePath(gameId) + "/details",
          gameDetailsSchema,
          signal,
          undefined,
          10_000,
          gameId,
        ),
        gameId,
      );
    },
    async unfinished(signal) {
      const { game } = await request("/games/unfinished", unfinishedGameDetailsSchema, signal);
      return game ? detailsFor(game) : null;
    },
    async invocations(gameId, signal) {
      const result = await request(
        gamePath(gameId) + "/invocations",
        gameInvocationsSchema,
        signal,
        undefined,
        10_000,
        gameId,
      );
      if (result.gameId !== gameId.toLowerCase()) throw new ApiFailure("malformed");
      return result;
    },
    async turn(command, credential, signal) {
      const body = validated(aiTurnRequestSchema, { ...command, ...credential });
      // Allow the server's operational deadline to pause and persist the turn before
      // the transport deadline. Never automatically retry an uncertain paid operation.
      return snapshotFor(
        await request(
          gamePath(command.gameId) + "/ai-turn",
          gameSnapshotSchema,
          signal,
          body,
          190_000,
          command.gameId,
        ),
        command.gameId,
      );
    },
  };
}
