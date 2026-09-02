import {
  createGameRequestSchema,
  gameErrorResponseSchema,
  gameParamsSchema,
  gameSnapshotSchema,
  guestSessionRequestSchema,
  guestSessionResponseSchema,
  moveCommandSchema,
  readinessResponseSchema,
  type GameErrorCode,
  type GameSnapshot,
  type MoveCommand,
} from "@neurochess/contracts";
import type { z } from "zod";

import { parsePosition } from "./board/position";

export type ApiFailureKind = "api" | "network" | "timeout" | "malformed" | "cancelled";

/** Only safe codes and validated snapshots survive the transport boundary. */
export class ApiFailure extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    readonly code?: GameErrorCode,
    readonly currentSnapshot?: GameSnapshot,
  ) {
    super(kind);
    this.name = "ApiFailure";
  }
}

export interface SandboxApi {
  ready(signal: AbortSignal): Promise<boolean>;
  bootstrap(signal: AbortSignal): Promise<void>;
  create(signal: AbortSignal): Promise<GameSnapshot>;
  snapshot(gameId: string, signal: AbortSignal): Promise<GameSnapshot>;
  move(command: MoveCommand, signal: AbortSignal): Promise<GameSnapshot>;
}

export function validateSnapshot(input: unknown): GameSnapshot {
  const parsed = gameSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new ApiFailure("malformed");
  const position = parsePosition(parsed.data.fen);
  if (!position || position.turn !== parsed.data.turn) throw new ApiFailure("malformed");
  return parsed.data;
}

export function createSandboxApi(
  apiBaseUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): SandboxApi {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 10_000, 30_000));

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
    readiness = false,
  ): Promise<T> {
    const abort = new AbortController();
    let timedOut = false;
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) abort.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    try {
      const response = await fetcher(new URL(path, apiBaseUrl), {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: abort.signal,
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ApiFailure("malformed");
      }
      if (!response.ok && !(readiness && response.status === 503)) {
        const error = gameErrorResponseSchema.safeParse(payload);
        if (!error.success) throw new ApiFailure("malformed");
        throw new ApiFailure(
          "api",
          error.data.code,
          error.data.code === "GAME_CONFLICT"
            ? validateSnapshot(error.data.currentSnapshot)
            : undefined,
        );
      }
      const result = schema.safeParse(payload);
      if (!result.success) throw new ApiFailure("malformed");
      return result.data;
    } catch (error: unknown) {
      if (signal.aborted) throw new ApiFailure("cancelled");
      if (timedOut) throw new ApiFailure("timeout");
      if (error instanceof ApiFailure) throw error;
      // Never retain, log, or render an exception or a server's message field.
      throw new ApiFailure("network");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
    }
  }

  function forGame(snapshot: GameSnapshot, gameId: string): GameSnapshot {
    if (snapshot.gameId !== gameId) throw new ApiFailure("malformed");
    return snapshot;
  }

  async function gameRequest(
    path: string,
    signal: AbortSignal,
    gameId?: string,
    body?: unknown,
  ): Promise<GameSnapshot> {
    try {
      const snapshot = validateSnapshot(await request(path, gameSnapshotSchema, signal, body));
      return gameId === undefined ? snapshot : forGame(snapshot, gameId);
    } catch (error: unknown) {
      if (error instanceof ApiFailure && error.currentSnapshot && gameId !== undefined) {
        forGame(error.currentSnapshot, gameId);
      }
      throw error;
    }
  }

  return {
    async ready(signal) {
      const response = await request("/ready", readinessResponseSchema, signal, undefined, true);
      return response.status === "ready";
    },
    async bootstrap(signal) {
      await request(
        "/guest-session",
        guestSessionResponseSchema,
        signal,
        guestSessionRequestSchema.parse({}),
      );
    },
    create: (signal) =>
      gameRequest("/sandbox/games", signal, undefined, createGameRequestSchema.parse({})),
    snapshot(gameId, signal) {
      const result = gameParamsSchema.safeParse({ gameId });
      if (!result.success) return Promise.reject(new ApiFailure("malformed"));
      return gameRequest("/games/" + gameId, signal, gameId);
    },
    move(command, signal) {
      const result = moveCommandSchema.safeParse(command);
      if (!result.success) return Promise.reject(new ApiFailure("malformed"));
      return gameRequest(
        "/games/" + command.gameId + "/moves",
        signal,
        command.gameId,
        result.data,
      );
    },
  };
}
