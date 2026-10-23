import {
  gameDeleteRequestSchema,
  type GameDetails,
  gameDetailsSchema,
  gameErrorResponseSchema,
  gameHistoryClearRequestSchema,
  type GameHistoryDeletedResponse,
  gameHistoryDeletedResponseSchema,
  type GameHistoryQuery,
  gameHistoryQuerySchema,
  type GameHistoryResponse,
  gameHistoryResponseSchema,
  gameParamsSchema,
  unfinishedGameDetailsSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

import { ApiFailure } from "./failures";
import { detailsFor, snapshotFor } from "./game-validation";
import { apiOrigin, createHttpRequest, validated as validate } from "./http";
import type { PublicIdentity } from "./identity";

export interface PublicGameApi {
  details(gameId: string, signal: AbortSignal): Promise<GameDetails>;
  unfinished(signal: AbortSignal): Promise<GameDetails | null>;
  history(query: GameHistoryQuery, signal: AbortSignal): Promise<GameHistoryResponse>;
  deleteGame(gameId: string, signal: AbortSignal): Promise<GameHistoryDeletedResponse>;
  clearHistory(signal: AbortSignal): Promise<GameHistoryDeletedResponse>;
}

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  return validate(schema, input, () => new ApiFailure("malformed"));
}

export function createPublicGameApi(
  apiBaseUrl: string,
  options: { fetch?: typeof fetch; identity?: PublicIdentity } = {},
): PublicGameApi {
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
      schema: gameErrorResponseSchema,
      failure: (kind) => new ApiFailure(kind),
      isFailure: (error): error is ApiFailure => error instanceof ApiFailure,
      fromResponse(error, gameId: string | undefined) {
        if (error.code === "UNAUTHORIZED" || error.code === "PROFILE_REQUIRED") identity?.lost?.();
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
    async details(gameId, signal) {
      return detailsFor(
        await request(gamePath(gameId) + "/details", gameDetailsSchema, signal, undefined, {
          errorContext: gameId,
        }),
        gameId.toLowerCase(),
      );
    },
    async unfinished(signal) {
      const { game } = await request("/games/unfinished", unfinishedGameDetailsSchema, signal);
      return game ? detailsFor(game) : null;
    },
    async history(query, signal) {
      if (options.identity?.intent !== "account") throw new ApiFailure("api", "UNAUTHORIZED");
      const input = validated(gameHistoryQuerySchema, query);
      const search = new URLSearchParams({
        limit: String(input.limit),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return request("/games/history?" + search.toString(), gameHistoryResponseSchema, signal);
    },
    async deleteGame(gameId, signal) {
      if (options.identity?.intent !== "account") throw new ApiFailure("api", "UNAUTHORIZED");
      return request(
        gamePath(gameId) + "/delete",
        gameHistoryDeletedResponseSchema,
        signal,
        validated(gameDeleteRequestSchema, { gameId, confirm: true }),
      );
    },
    async clearHistory(signal) {
      if (options.identity?.intent !== "account") throw new ApiFailure("api", "UNAUTHORIZED");
      return request(
        "/games/history/clear",
        gameHistoryDeletedResponseSchema,
        signal,
        validated(gameHistoryClearRequestSchema, { confirm: true }),
      );
    },
  };
}
