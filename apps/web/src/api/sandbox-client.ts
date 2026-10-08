import {
  createGameRequestSchema,
  gameErrorResponseSchema,
  gameParamsSchema,
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  guestSessionRequestSchema,
  guestSessionResponseSchema,
  lifecycleCommandSchema,
  moveCommandSchema,
  readinessResponseSchema,
  unfinishedGameResponseSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

import { ApiFailure } from "./failures";
import type { GameCommandApi } from "./game-command-api";
import { pgnFor, replayFor, snapshotFor } from "./game-validation";
import { createHttpRequest, validated } from "./http";
export { ApiFailure, type ApiFailureKind } from "./failures";

export interface SandboxApi extends GameCommandApi {
  ready(signal: AbortSignal): Promise<boolean>;
  create(signal: AbortSignal): Promise<GameSnapshot>;
  unfinished(signal: AbortSignal): Promise<GameSnapshot | null>;
}

export function createSandboxApi(
  apiBaseUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): SandboxApi {
  const request = createHttpRequest({
    baseUrl: apiBaseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 10_000, 30_000)),
    errors: {
      schema: gameErrorResponseSchema,
      failure: (kind) => new ApiFailure(kind),
      isFailure: (error): error is ApiFailure => error instanceof ApiFailure,
      fromResponse: (error, gameId: string | undefined) =>
        new ApiFailure(
          "api",
          error.code,
          error.code === "GAME_CONFLICT" ? snapshotFor(error.currentSnapshot, gameId) : undefined,
        ),
    },
  });
  function input<T>(schema: z.ZodType<T>, value: unknown): T {
    return validated(schema, value, () => new ApiFailure("malformed"));
  }
  async function gameRequest(path: string, signal: AbortSignal, gameId?: string, body?: unknown) {
    return snapshotFor(
      await request(path, gameSnapshotSchema, signal, body, { errorContext: gameId }),
      gameId,
    );
  }

  return {
    async ready(signal) {
      const response = await request("/ready", readinessResponseSchema, signal, undefined, {
        acceptStatus: 503,
      });
      return response.status === "ready";
    },
    async bootstrap(signal) {
      await request(
        "/guest-session",
        guestSessionResponseSchema,
        signal,
        input(guestSessionRequestSchema, {}),
      );
    },
    create: (signal) =>
      gameRequest("/sandbox/games", signal, undefined, input(createGameRequestSchema, {})),
    async snapshot(gameId, signal) {
      input(gameParamsSchema, { gameId });
      return gameRequest("/games/" + gameId, signal, gameId);
    },
    async move(command, signal) {
      const body = input(moveCommandSchema, command);
      return gameRequest("/games/" + command.gameId + "/moves", signal, command.gameId, body);
    },
    async lifecycle(command, signal) {
      const body = input(lifecycleCommandSchema, command);
      return gameRequest("/games/" + command.gameId + "/lifecycle", signal, command.gameId, body);
    },
    async unfinished(signal) {
      const response = await request(
        "/sandbox/games/unfinished",
        unfinishedGameResponseSchema,
        signal,
      );
      return response.snapshot ? snapshotFor(response.snapshot) : null;
    },
    async replay(gameId, signal) {
      input(gameParamsSchema, { gameId });
      const response = await request(
        "/games/" + gameId + "/replay",
        gameReplayResponseSchema,
        signal,
      );
      return replayFor(response, gameId);
    },
    async pgn(gameId, signal) {
      input(gameParamsSchema, { gameId });
      const response = await request("/games/" + gameId + "/pgn", gamePgnResponseSchema, signal);
      return pgnFor(response, gameId);
    },
  };
}
