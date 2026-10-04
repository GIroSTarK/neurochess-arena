import { matchPath } from "react-router";

import type { GameTarget } from "./navigation";
import { type GameMode, parseGameId } from "./route-urls";

export interface RouteAddress {
  readonly pathname: string;
  readonly search: string;
}

export function gameRouteTarget(
  mode: GameMode,
  location: RouteAddress,
  gameId: unknown,
): GameTarget {
  if (new URLSearchParams(location.search).has("game")) return { kind: "invalid" };
  const base = mode === "arena" ? "" : "/sandbox";
  if (location.pathname === (base || "/") || location.pathname === `${base}/`) {
    return { kind: "none" };
  }
  const id = parseGameId(gameId);
  const pattern = new RegExp(`^${base}/games/[^/%?#]+/?$`);
  return id && pattern.test(location.pathname) ? { kind: "game", gameId: id } : { kind: "invalid" };
}

export function gameRouteKey(mode: GameMode, location: RouteAddress): string | null {
  const match = matchPath(
    { path: `${mode === "arena" ? "" : "/sandbox"}/games/:gameId`, caseSensitive: true },
    location.pathname,
  );
  const target = gameRouteTarget(mode, location, match?.params.gameId);
  return target.kind === "invalid" ? null : target.kind === "none" ? "setup" : target.gameId;
}

export interface RouteOwner {
  readonly accepts: (location: RouteAddress) => boolean;
  readonly end: () => void;
}

// Lives with the router, never in router results or browser history state.
export class RouteNavigation {
  private readonly owners = new Set<RouteOwner>();
  private focusHandoff: string | null = null;

  register(owner: RouteOwner) {
    this.owners.add(owner);
    return () => {
      this.owners.delete(owner);
    };
  }

  departing(location: RouteAddress) {
    for (const owner of this.owners) if (!owner.accepts(location)) owner.end();
    if (this.focusHandoff !== location.pathname) this.focusHandoff = null;
  }

  preserveFocus(pathname: string) {
    this.focusHandoff = pathname;
  }

  takeFocusHandoff(pathname: string) {
    const preserve = this.focusHandoff === pathname;
    this.focusHandoff = null;
    return preserve;
  }
}
