import { isAiGameMode, type RoomView } from "@neurochess/contracts";
import type { LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from "react-router";

import { createCredentialApi } from "../api/credential-client";
import { ApiFailure } from "../api/failures";
import { createPublicGameApi } from "../api/public-game-client";
import { createRoomGameApi } from "../api/room-game-client";
import type { CredentialCatalogState } from "../credentials/catalog";
import { isAccessFailure } from "../gameplay/failures";
import type { RoomEntryFeature } from "../rooms/route-data";
import type { AppRouteContext } from "../routing/route-context";
import { protectedLoader } from "../routing/route-data";
import { gameRouteKey, gameRouteTarget } from "../routing/route-navigation";
import type { PublicAccess, ScopedRouteData } from "../routing/route-runtime";
import type { SetupEntry } from "../setup/controller";

import type { MatchEntry } from "./controller";

export type ArenaEntry =
  | (SetupEntry & { readonly kind: "setup" })
  | Exclude<MatchEntry, { kind: "setup" }>
  | { readonly kind: "room"; readonly room: RoomView }
  | { readonly kind: "handoff"; readonly gameId: string };
export type ArenaRouteData = ScopedRouteData<{
  readonly access: PublicAccess;
  readonly entry: ArenaEntry | null;
  readonly credentials: CredentialCatalogState | null;
}>;
type ArenaContext = Pick<AppRouteContext, "apiBaseUrl" | "runtime" | "navigation">;

function entryLoader(context: ArenaContext, kind: "setup" | "game", rooms?: RoomEntryFeature) {
  const { runtime, apiBaseUrl, navigation } = context;
  let latest: ArenaRouteData | null = null;
  const loader = protectedLoader(
    async ({ request, params }: LoaderFunctionArgs): Promise<ArenaRouteData | null> => {
      const url = new URL(request.url);
      const target = gameRouteTarget("arena", url, params.gameId);
      if (target.kind === "invalid" || (kind === "game" && target.kind !== "game")) return null;
      const resolved = await runtime.resolvePublicIdentity(request.signal, true);
      const { identity, generation, access } = resolved;
      const result = (
        entry: ArenaEntry | null,
        credentials: CredentialCatalogState | null = null,
      ) => {
        latest = runtime.result(generation, { access, entry, credentials });
        return latest;
      };
      if (!identity) return result(null);
      const signal = AbortSignal.any([request.signal, identity.signal]);
      const cancelled = () => signal.aborted;
      // Retain the old generation on identity cancellation so the router can
      // revalidate after resolution, even if it was still waiting for this read.
      const cancelledResult = () => (request.signal.aborted ? null : result(null));
      if (cancelled()) return cancelledResult();
      const handoff = target.kind === "game" ? rooms?.peekHandoff(target.gameId) : null;
      if (handoff) return result({ kind: "room", room: handoff });
      // Only a still-mounted owner can authorize this one navigation to reuse its creation.
      if (target.kind === "game" && navigation.hasHandoff(url)) {
        return result({ kind: "handoff", gameId: target.gameId });
      }
      const api = createPublicGameApi(apiBaseUrl, { identity });
      let entry: ArenaEntry;
      try {
        if (kind === "setup") {
          const game = await api.unfinished(signal);
          entry = { kind: "setup", existingGameId: game?.snapshot.gameId ?? null, issue: null };
        } else if (target.kind === "game") {
          const details = await api.details(target.gameId, signal);
          entry =
            details.configuration?.mode === "human_vs_human"
              ? {
                  kind: "room",
                  room: await createRoomGameApi(apiBaseUrl, identity).read(target.gameId, signal),
                }
              : { kind: "game", gameId: target.gameId, details };
        } else return null;
      } catch (error) {
        if (cancelled()) return cancelledResult();
        entry =
          kind === "setup"
            ? {
                kind: "setup",
                existingGameId: null,
                issue:
                  identity.intent === "guest" &&
                  error instanceof ApiFailure &&
                  error.code === "UNAUTHORIZED"
                    ? null
                    : { code: isAccessFailure(error) ? "access" : "unavailable" },
              }
            : { kind: "unavailable", code: isAccessFailure(error) ? "access" : "unavailable" };
      }
      if (cancelled()) return cancelledResult();
      const needsCredentials =
        entry.kind === "setup" ||
        (entry.kind === "game" &&
          isAiGameMode(entry.details.configuration?.mode) &&
          (entry.details.snapshot.state === "active" || entry.details.snapshot.state === "paused"));
      let credentials: CredentialCatalogState | null = null;
      if (identity.intent === "account" && needsCredentials) {
        try {
          const metadata = await createCredentialApi(apiBaseUrl, identity).list(signal);
          credentials = { phase: "ready", credentials: metadata.credentials };
        } catch {
          credentials = { phase: "error", credentials: [] };
        }
      }
      return cancelled() ? cancelledResult() : result(entry, credentials);
    },
  );
  const shouldRevalidate = (args: ShouldRevalidateFunctionArgs) => {
    if (!latest?.data || latest.generation !== runtime.account.getSnapshot().revision) return true;
    if (gameRouteKey("arena", args.currentUrl) !== gameRouteKey("arena", args.nextUrl)) return true;
    // Same-game form acknowledgements do not own the gameplay snapshot. Explicit
    // revalidation and entry retries still read, with adoption decided by the owner.
    if (kind === "game" && args.formMethod && args.formMethod !== "GET") return false;
    return args.defaultShouldRevalidate;
  };
  return { loader, shouldRevalidate };
}

export const arenaSetupLoader = (context: ArenaContext) => entryLoader(context, "setup");
export const arenaGameLoader = (context: ArenaContext, rooms?: RoomEntryFeature) =>
  entryLoader(context, "game", rooms);
