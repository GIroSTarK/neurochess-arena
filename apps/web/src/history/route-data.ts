import {
  gameHistoryCursorSchema,
  type GameHistoryResponse,
  gameParamsSchema,
} from "@neurochess/contracts";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import { z } from "zod";

import { createAiApi } from "../api/ai-client";
import { accountError, AccountFailure } from "../api/auth-client";
import { ApiFailure } from "../api/failures";
import type { AppRouteContext } from "../app/route-context";
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
const confirmation = { confirm: z.literal("true"), expectedAccount: gameParamsSchema.shape.gameId };
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
  const pages = new Set<WeakRef<HistoryRouteData>>();
  let deletionRevision = 0;

  const loader = async ({ request }: LoaderFunctionArgs): Promise<HistoryRouteData | null> => {
    const revision = deletionRevision;
    try {
      const { identity, generation, access } = await runtime.resolvePublicIdentity(
        request.signal,
        true,
      );
      const result = (page: GameHistoryResponse | null, error = false) => {
        const scoped = runtime.result(generation, {
          access,
          page: revision === deletionRevision ? page : null,
          error,
        });
        for (const reference of pages) if (!reference.deref()) pages.delete(reference);
        pages.add(new WeakRef(scoped));
        return scoped;
      };
      if (access !== "account" || !identity) return result(null);
      const query = new URL(request.url).searchParams;
      const parsed = querySchema.safeParse(Object.fromEntries(query));
      if (!parsed.success || new Set(query.keys()).size !== [...query].length) {
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
    } catch (error) {
      if (request.signal.aborted || accountError(error) === "cancelled") return null;
      throw new AccountFailure("AUTH_UNAVAILABLE");
    }
  };

  const action = async ({ request }: ActionFunctionArgs): Promise<HistoryActionData | null> => {
    const operation = runtime.beginAction(request.signal);
    let generation = runtime.account.getSnapshot().revision;
    const result = (outcome: HistoryOutcome) => runtime.result(generation, outcome);
    try {
      if (request.method !== "POST") return result({ error: "rejected" });
      const form = await request.formData();
      const parsed = intentSchema.safeParse(Object.fromEntries(form));
      if (!parsed.success || new Set(form.keys()).size !== [...form].length) {
        return result({ error: "rejected" });
      }
      const resolved = await runtime.resolvePublicIdentity(operation.signal, true);
      generation = resolved.generation;
      const { identity } = resolved;
      if (
        resolved.access !== "account" ||
        parsed.data.expectedAccount !== identity?.expectedAccount
      ) {
        return result({ error: "rejected" });
      }
      const signal = AbortSignal.any([operation.signal, identity.signal]);
      const api = createAiApi(apiBaseUrl, { identity });
      if (parsed.data.intent === "delete-game") await api.deleteGame(parsed.data.gameId, signal);
      else await api.clearHistory(signal);
      if (signal.aborted) return null;
      // Clear the actual router/cache references before refresh and fence reads
      // begun before this acknowledgement, including consistent pre-delete views.
      deletionRevision++;
      for (const reference of pages) {
        const page = reference.deref();
        if (page?.data) page.data.page = null;
      }
      pages.clear();
      return result({ success: parsed.data.intent === "delete-game" ? "game" : "history" });
    } catch (error) {
      return operation.signal.aborted ? null : result(deletionError(error));
    } finally {
      operation.release();
    }
  };

  const shouldRevalidate = (args: ShouldRevalidateFunctionArgs) => {
    // The screen resets its cursor fetcher before explicitly refreshing after a
    // confirmed write. Failed writes require an explicit retry or refresh too.
    if (
      args.formMethod === "POST" &&
      args.formAction &&
      new URL(args.formAction, args.currentUrl).pathname === "/history"
    ) {
      return false;
    }
    return args.defaultShouldRevalidate;
  };
  return { loader, action, shouldRevalidate };
}
