import type { LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from "react-router";

import { createSandboxApi } from "../api/client";
import type { AppRouteContext } from "../app/route-context";
import { gameRouteKey, gameRouteTarget } from "../app/route-navigation";

import type { SandboxEntry } from "./controller";
import { failureNotice, isAccessCode, safeFailure } from "./failures";

export type SandboxRouteData =
  | { readonly kind: "entry"; readonly entry: SandboxEntry }
  | { readonly kind: "handoff"; readonly gameId: string };

type SandboxContext = Pick<AppRouteContext, "apiBaseUrl" | "sandboxEnabled" | "navigation">;

function entryLoader(context: SandboxContext, kind: "setup" | "game") {
  const loader = async ({
    request,
    params,
  }: LoaderFunctionArgs): Promise<SandboxRouteData | null> => {
    const cancelled = () => request.signal.aborted;
    const url = new URL(request.url);
    const target = gameRouteTarget("sandbox", url, params.gameId);
    if (
      !context.sandboxEnabled ||
      import.meta.env.SANDBOX_ENABLED !== "true" ||
      target.kind === "invalid" ||
      (kind === "game" && target.kind !== "game") ||
      cancelled()
    ) {
      return null;
    }
    if (target.kind === "game" && context.navigation.hasHandoff(url)) {
      return { kind: "handoff", gameId: target.gameId };
    }
    const api = createSandboxApi(context.apiBaseUrl);
    const [readiness, entry] = await Promise.all([
      api.ready(request.signal).catch(() => false),
      (target.kind === "game"
        ? api.snapshot(target.gameId, request.signal)
        : api.unfinished(request.signal)
      ).then(
        (snapshot): SandboxEntry => ({ target, snapshot }),
        (error: unknown): SandboxEntry => {
          const failure = safeFailure(error);
          if (target.kind === "none" && failure.code === "UNAUTHORIZED") {
            return { target, snapshot: null };
          }
          const unavailable = target.kind === "none" && failure.code === "NOT_FOUND";
          return {
            target,
            issue: {
              phase: unavailable
                ? "unavailable"
                : isAccessCode(failure.code)
                  ? "access-error"
                  : "recovery-required",
              notice: unavailable ? "sandbox-unavailable" : failureNotice(failure),
            },
          };
        },
      ),
    ]);
    return cancelled() ? null : { kind: "entry", entry: { ...entry, readiness } };
  };
  const shouldRevalidate = (args: ShouldRevalidateFunctionArgs) => {
    if (gameRouteKey("sandbox", args.currentUrl) !== gameRouteKey("sandbox", args.nextUrl)) {
      return true;
    }
    if (kind === "game" && args.formMethod && args.formMethod !== "GET") return false;
    return args.defaultShouldRevalidate;
  };
  return { loader, shouldRevalidate };
}

export const sandboxEntryLoader = (context: SandboxContext) => entryLoader(context, "setup");
export const sandboxGameLoader = (context: SandboxContext) => entryLoader(context, "game");
