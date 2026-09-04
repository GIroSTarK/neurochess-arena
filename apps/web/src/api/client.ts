import {
  createGameRequestSchema,
  type GameErrorCode,
  gameErrorResponseSchema,
  gameParamsSchema,
  type GamePgnResponse,
  gamePgnResponseSchema,
  type GameReplayResponse,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  guestSessionRequestSchema,
  guestSessionResponseSchema,
  type LifecycleCommand,
  lifecycleCommandSchema,
  type MoveCommand,
  moveCommandSchema,
  readinessResponseSchema,
  unfinishedGameResponseSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

import { parsePosition } from "../chess/position";

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
  lifecycle(command: LifecycleCommand, signal: AbortSignal): Promise<GameSnapshot>;
  unfinished(signal: AbortSignal): Promise<GameSnapshot | null>;
  replay(gameId: string, signal: AbortSignal): Promise<GameReplayResponse>;
  pgn(gameId: string, signal: AbortSignal): Promise<GamePgnResponse>;
}

export function validateSnapshot(input: unknown): GameSnapshot {
  const parsed = gameSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new ApiFailure("malformed");
  const position = parsePosition(parsed.data.fen);
  if (position?.turn !== parsed.data.turn) throw new ApiFailure("malformed");
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
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) abort.abort();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
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
      // The caller did not cancel, so only the timeout can have aborted the request.
      if (abort.signal.aborted) throw new ApiFailure("timeout");
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
    lifecycle(command, signal) {
      const result = lifecycleCommandSchema.safeParse(command);
      if (!result.success) return Promise.reject(new ApiFailure("malformed"));
      return gameRequest(
        "/games/" + command.gameId + "/lifecycle",
        signal,
        command.gameId,
        result.data,
      );
    },
    async unfinished(signal) {
      const response = await request(
        "/sandbox/games/unfinished",
        unfinishedGameResponseSchema,
        signal,
      );
      return response.snapshot ? validateSnapshot(response.snapshot) : null;
    },
    async replay(gameId, signal) {
      if (!gameParamsSchema.safeParse({ gameId }).success) throw new ApiFailure("malformed");
      const response = await request(
        "/games/" + gameId + "/replay",
        gameReplayResponseSchema,
        signal,
      );
      const snapshot = forGame(validateSnapshot(response.snapshot), gameId);
      if (!parsePosition(response.initialFen)) throw new ApiFailure("malformed");
      for (const move of snapshot.moves)
        if (!parsePosition(move.fen)) throw new ApiFailure("malformed");
      return response;
    },
    async pgn(gameId, signal) {
      if (!gameParamsSchema.safeParse({ gameId }).success) throw new ApiFailure("malformed");
      const response = await request("/games/" + gameId + "/pgn", gamePgnResponseSchema, signal);
      if (response.gameId !== gameId) throw new ApiFailure("malformed");
      return response;
    },
  };
}
