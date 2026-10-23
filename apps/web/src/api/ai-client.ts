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
} from "@neurochess/contracts";
import type { z } from "zod";

import { ApiFailure } from "./failures";
import type { GameCommandApi } from "./game-command-api";
import { detailsFor, pgnFor, replayFor, snapshotFor } from "./game-validation";
import { apiOrigin, createHttpRequest, validated as validate } from "./http";
import type { PublicIdentity } from "./identity";
import { createPublicGameApi, type PublicGameApi } from "./public-game-client";

export class AiRequestFailure extends Error {
  constructor(readonly code: AiRequestErrorCode | "AI_KEY_REQUIRED") {
    super(code);
    this.name = "AiRequestFailure";
  }
}

export interface AiApi extends GameCommandApi, Pick<PublicGameApi, "details" | "unfinished"> {
  discover(input: ModelDiscoveryRequest, signal: AbortSignal): Promise<ModelDiscoveryResult>;
  create(configuration: AiGameConfiguration, signal: AbortSignal): Promise<GameDetails>;
  invocations(gameId: string, signal: AbortSignal): Promise<GameInvocations>;
  controller(command: AiControllerRequest, signal: AbortSignal): Promise<GameSnapshot>;
  turn(
    command: AiControlledTurnCommand,
    credential: ProviderCredentialSource,
    signal: AbortSignal,
  ): Promise<GameSnapshot>;
}

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  return validate(schema, input, () => new ApiFailure("malformed"));
}

export function createAiApi(
  apiBaseUrl: string,
  options: { fetch?: typeof fetch; identity?: PublicIdentity } = {},
): AiApi {
  const publicGames = createPublicGameApi(apiBaseUrl, options);
  const identity = options.identity;
  const request = createHttpRequest({
    baseUrl: apiOrigin(apiBaseUrl, () => new ApiFailure("malformed")),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    headers: {
      "x-neurochess-identity": identity?.intent ?? "guest",
      ...(identity?.expectedAccount
        ? { "x-neurochess-expected-account": identity.expectedAccount }
        : {}),
    },
    ...(identity
      ? {
          signal: identity.signal,
          beforeRequest: () => identity.verify(),
          afterResponse: () => identity.verify(),
        }
      : {}),
    errors: {
      schema: aiErrorResponseSchema,
      failure: (kind) => new ApiFailure(kind),
      isFailure: (error): error is ApiFailure | AiRequestFailure =>
        error instanceof ApiFailure || error instanceof AiRequestFailure,
      fromResponse(error, gameId: string | undefined) {
        if (error.code === "UNAUTHORIZED" || error.code === "PROFILE_REQUIRED") identity?.lost?.();
        if (!("message" in error)) return new AiRequestFailure(error.code);
        return new ApiFailure(
          "api",
          error.code,
          error.code === "GAME_CONFLICT"
            ? snapshotFor(error.currentSnapshot, gameId?.toLowerCase())
            : undefined,
        );
      },
    },
  });

  function gamePath(gameId: string) {
    return "/games/" + validated(gameParamsSchema, { gameId }).gameId.toLowerCase();
  }

  return {
    details: publicGames.details.bind(publicGames),
    unfinished: publicGames.unfinished.bind(publicGames),
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
        await request(gamePath(gameId), gameSnapshotSchema, signal, undefined, {
          errorContext: gameId,
        }),
        gameId.toLowerCase(),
      );
    },
    async move(command, signal) {
      return snapshotFor(
        await request(
          gamePath(command.gameId) + "/moves",
          gameSnapshotSchema,
          signal,
          validated(moveCommandSchema, command),
          { errorContext: command.gameId },
        ),
        command.gameId.toLowerCase(),
      );
    },
    async lifecycle(command, signal) {
      return snapshotFor(
        await request(
          gamePath(command.gameId) + "/lifecycle",
          gameSnapshotSchema,
          signal,
          validated(lifecycleCommandSchema, command),
          { errorContext: command.gameId },
        ),
        command.gameId.toLowerCase(),
      );
    },
    async controller(command, signal) {
      return snapshotFor(
        await request(
          gamePath(command.gameId) + "/controller",
          gameSnapshotSchema,
          signal,
          validated(aiControllerRequestSchema, command),
          { errorContext: command.gameId },
        ),
        command.gameId.toLowerCase(),
      );
    },
    async replay(gameId, signal) {
      const replay = await request(
        gamePath(gameId) + "/replay",
        gameReplayResponseSchema,
        signal,
        undefined,
        { errorContext: gameId },
      );
      return replayFor(replay, gameId.toLowerCase());
    },
    async pgn(gameId, signal) {
      const result = await request(
        gamePath(gameId) + "/pgn",
        gamePgnResponseSchema,
        signal,
        undefined,
        { errorContext: gameId },
      );
      return pgnFor(result, gameId.toLowerCase());
    },
    discover: async (input, signal) =>
      request(
        "/providers/models",
        modelDiscoveryResultSchema,
        signal,
        validated(modelDiscoveryRequestSchema, input),
        { timeoutMs: 35_000 },
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
    async invocations(gameId, signal) {
      const result = await request(
        gamePath(gameId) + "/invocations",
        gameInvocationsSchema,
        signal,
        undefined,
        { errorContext: gameId },
      );
      if (result.gameId !== gameId.toLowerCase()) throw new ApiFailure("malformed");
      return result;
    },
    async turn(command, credential, signal) {
      const body = validated(aiTurnRequestSchema, { ...command, ...credential });
      // Allow the server's operational deadline to pause and persist the turn before
      // the transport deadline. Never automatically retry an uncertain paid operation.
      return snapshotFor(
        await request(gamePath(command.gameId) + "/ai-turn", gameSnapshotSchema, signal, body, {
          timeoutMs: 190_000,
          errorContext: command.gameId,
        }),
        command.gameId.toLowerCase(),
      );
    },
  };
}
