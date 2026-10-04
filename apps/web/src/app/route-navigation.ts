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
  readonly hasHandoff?: (location: RouteAddress) => boolean;
  readonly arrived?: (location: RouteAddress) => void;
}

// Lives with the router, never in router results or browser history state.
export class RouteNavigation {
  private readonly owners = new Set<RouteOwner>();
  private readonly listeners = new Set<(location: RouteAddress) => void>();
  private focusHandoff: string | null = null;
  private destination: RouteAddress | null = null;

  subscribe(listener: (location: RouteAddress) => void) {
    this.listeners.add(listener);
    if (this.destination) listener(this.destination);
    return () => {
      this.listeners.delete(listener);
    };
  }

  register(owner: RouteOwner) {
    this.owners.add(owner);
    if (this.destination && !owner.accepts(this.destination)) owner.end();
    return () => {
      this.owners.delete(owner);
    };
  }

  hasHandoff(location: RouteAddress) {
    return [...this.owners].some((owner) => owner.hasHandoff?.(location));
  }

  arrived(location: RouteAddress) {
    for (const owner of this.owners) owner.arrived?.(location);
  }

  departing(location: RouteAddress) {
    this.destination = location;
    for (const listener of this.listeners) listener(location);
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
