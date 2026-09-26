import {
  GAME_IDENTITY_HEADER,
  gameErrorResponseSchema,
  gameHistoryPageSchema,
  gameHistoryQuerySchema,
} from "@neurochess/contracts";

import { ApiFailure } from "../api/failures";

export async function loadHistory(baseUrl: string, cursor: string | null, signal: AbortSignal) {
  const query = gameHistoryQuerySchema.safeParse(cursor ? { cursor } : {});
  if (!query.success) throw new ApiFailure("malformed");
  const cancelled = () => signal.aborted;
  try {
    if (cancelled()) throw new ApiFailure("cancelled");
    const response = await fetch(
      new URL("/games/history" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), baseUrl),
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { accept: "application/json", [GAME_IDENTITY_HEADER]: "account" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    );
    const payload: unknown = await response.json();
    if (cancelled()) throw new ApiFailure("cancelled");
    if (!response.ok) {
      const error = gameErrorResponseSchema.safeParse(payload);
      if (!error.success) throw new ApiFailure("malformed");
      throw new ApiFailure("api", error.data.code);
    }
    const page = gameHistoryPageSchema.safeParse(payload);
    if (!page.success) throw new ApiFailure("malformed");
    return page.data;
  } catch (error) {
    if (cancelled()) throw new ApiFailure("cancelled");
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure("network");
  }
}
