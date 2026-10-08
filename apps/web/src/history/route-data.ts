import {
  gameHistoryCursorSchema,
  type GameHistoryResponse,
  gameParamsSchema,
} from "@neurochess/contracts";
import { z } from "zod";

import { createAiApi } from "../api/ai-client";
import { ApiFailure } from "../api/failures";
import { accountIdSchema } from "../api/identifier-schemas";
import { FencedResults } from "../app/fenced-results";
import type { AppRouteContext } from "../app/route-context";
import {
  protectedLoader,
  routeAction,
  selfPostRevalidation,
  strictFormIntent,
} from "../app/route-data";
import { type PublicAccess, type ScopedRouteData, waitForRouteResult } from "../app/route-runtime";

export type HistoryRouteData = ScopedRouteData<{
  readonly access: PublicAccess;
  page: GameHistoryResponse | null;
  readonly error: boolean;
}>;
export type HistoryOutcome =
  | { readonly success: "game" | "history" }
  | { readonly error: "unfinished" | "rejected" | "unconfirmed" };
export type HistoryActionData = ScopedRouteData<HistoryOutcome>;

const querySchema = z.strictObject({ cursor: gameHistoryCursorSchema.optional() });
const confirmation = { confirm: z.literal("true"), expectedAccount: accountIdSchema };
const intentSchema = z.discriminatedUnion("intent", [
  z.strictObject({
    intent: z.literal("delete-game"),
    gameId: gameParamsSchema.shape.gameId,
    ...confirmation,
  }),
  z.strictObject({ intent: z.literal("clear-history"), ...confirmation }),
]);
export type HistoryIntent = z.infer<typeof intentSchema>;

function deletionError(error: unknown): HistoryOutcome {
  if (!(error instanceof ApiFailure) || error.kind !== "api" || !error.code) {
    return { error: "unconfirmed" };
  }
  if (error.code === "INVALID_GAME_STATE") return { error: "unfinished" };
  return { error: error.code === "INTERNAL_SERVER_ERROR" ? "unconfirmed" : "rejected" };
}

export function historyRouteData({
  apiBaseUrl,
  runtime,
}: Pick<AppRouteContext, "apiBaseUrl" | "runtime">) {
  const pages = new FencedResults<NonNullable<HistoryRouteData["data"]>>((data) => {
    data.page = null;
  });

  const loader = protectedLoader(async ({ request }): Promise<HistoryRouteData | null> => {
    const read = pages.beginRead();
    const { identity, generation, access } = await runtime.resolvePublicIdentity(
      request.signal,
      true,
    );
    const result = (page: GameHistoryResponse | null, error = false) => {
      return read(runtime.result(generation, { access, page, error }));
    };
    if (access !== "account" || !identity) return result(null);
    const query = new URL(request.url).searchParams;
    const parsed = querySchema.safeParse({ cursor: query.get("cursor") ?? undefined });
    if (!parsed.success || query.getAll("cursor").length > 1) {
      return result(null, true);
    }
    const signal = AbortSignal.any([request.signal, identity.signal]);
    try {
      const page = await waitForRouteResult(
        createAiApi(apiBaseUrl, { identity }).history({ limit: 20, ...parsed.data }, signal),
        signal,
      );
      return request.signal.aborted ? null : result(signal.aborted ? null : page);
    } catch {
      return request.signal.aborted ? null : result(null, !signal.aborted);
    }
  });

  const action = routeAction(
    runtime,
    async ({ request }, scope): Promise<HistoryActionData | null> => {
      const result = (outcome: HistoryOutcome) => scope.result(outcome);
      try {
        if (request.method !== "POST") return result({ error: "rejected" });
        const form = await request.formData();
        const input = strictFormIntent(form, intentSchema);
        if (!input) {
          return result({ error: "rejected" });
        }
        const identity = await scope.resolveAccount(input.expectedAccount, true);
        if (!identity) {
          return result({ error: "rejected" });
        }
        const signal = AbortSignal.any([scope.signal, identity.signal]);
        const api = createAiApi(apiBaseUrl, { identity });
        if (input.intent === "delete-game") await api.deleteGame(input.gameId, signal);
        else await api.clearHistory(signal);
        if (signal.aborted) return null;
        pages.invalidate();
        return result({ success: input.intent === "delete-game" ? "game" : "history" });
      } catch (error) {
        return scope.signal.aborted ? null : result(deletionError(error));
      }
    },
  );

  const shouldRevalidate = selfPostRevalidation("/history");
  return { loader, action, shouldRevalidate };
}
