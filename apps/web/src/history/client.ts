import {
  GAME_IDENTITY_HEADER,
  gameDeletionRequestSchema,
  gameDeletionResponseSchema,
  gameErrorResponseSchema,
  gameHistoryPageSchema,
  gameHistoryQuerySchema,
  gameIdSchema,
} from "@neurochess/contracts";
import type { ZodType } from "zod";

import { ApiFailure } from "../api/failures";

export async function loadHistory(baseUrl: string, cursor: string | null, signal: AbortSignal) {
  const query = gameHistoryQuerySchema.safeParse(cursor ? { cursor } : {});
  if (!query.success) throw new ApiFailure("malformed");
  return requestHistory(
    baseUrl,
    "/games/history" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
    signal,
    gameHistoryPageSchema,
  );
}

export function deleteGame(baseUrl: string, gameId: string, signal: AbortSignal) {
  if (!gameIdSchema.safeParse(gameId).success) throw new ApiFailure("malformed");
  return requestHistory(
    baseUrl,
    `/games/${gameId}/delete`,
    signal,
    gameDeletionResponseSchema,
    "POST",
  );
}

export function clearHistory(baseUrl: string, signal: AbortSignal) {
  return requestHistory(
    baseUrl,
    "/games/history/clear",
    signal,
    gameDeletionResponseSchema,
    "POST",
  );
}

async function requestHistory<T>(
  baseUrl: string,
  path: string,
  signal: AbortSignal,
  schema: ZodType<T>,
  method: "GET" | "POST" = "GET",
): Promise<T> {
  const cancelled = () => signal.aborted;
  try {
    if (cancelled()) throw new ApiFailure("cancelled");
    const response = await fetch(new URL(path, baseUrl), {
      method,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json",
        [GAME_IDENTITY_HEADER]: "account",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST"
        ? { body: JSON.stringify(gameDeletionRequestSchema.parse({ confirm: true })) }
        : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    const payload: unknown = await response.json();
    if (cancelled()) throw new ApiFailure("cancelled");
    if (!response.ok) {
      const error = gameErrorResponseSchema.safeParse(payload);
      if (!error.success) throw new ApiFailure("malformed");
      throw new ApiFailure("api", error.data.code);
    }
    const page = schema.safeParse(payload);
    if (!page.success) throw new ApiFailure("malformed");
    return page.data;
  } catch (error) {
    if (cancelled()) throw new ApiFailure("cancelled");
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure("network");
  }
}
