import { expect, it, vi } from "vitest";

import { GAME_ID } from "../test/fixtures";

import { GameRouteLifetime } from "./game-route-lifetime";
import type { GameTarget } from "./navigation";
import { RouteNavigation } from "./route-navigation";

it("publishes departure atomically and keeps canceled departure stopped until retry", () => {
  const navigation = new RouteNavigation();
  let active = false;
  const lifetime = new GameRouteLifetime(
    "arena",
    () => ({
      endLifetime: () => {
        active = false;
      },
    }),
    () => {
      active = true;
    },
    () => undefined,
    navigation,
  );
  const disconnect = lifetime.connect({ kind: "game", gameId: GAME_ID });
  lifetime.activate();
  const snapshots: unknown[] = [];
  const unsubscribe = lifetime.subscribe(() => snapshots.push(lifetime.getSnapshot()));
  try {
    navigation.departing({ pathname: "/history", search: "" });
    expect(active).toBe(false);
    expect(snapshots).toEqual(["departing"]);
    const origin = { pathname: "/games/" + GAME_ID, search: "" };
    navigation.departing(origin);
    navigation.arrived(origin);
    expect(lifetime.getSnapshot()).toBe("stopped");
    expect(active).toBe(false);
    lifetime.retry();
    expect(lifetime.getSnapshot()).toBe("running");
    expect(active).toBe(true);
  } finally {
    unsubscribe();
    disconnect();
  }
});

it("keeps a handoff connected when the controller renders before the router transition", () => {
  const navigation = new RouteNavigation();
  let game: (id: string, reason: "created" | "recovered") => void = () => undefined;
  const endLifetime = vi.fn();
  const lifetime = new GameRouteLifetime(
    "sandbox",
    (callbacks) => {
      game = callbacks.game;
      return { endLifetime };
    },
    () => undefined,
    () => undefined,
    navigation,
  );
  const setup: GameTarget = { kind: "none" };
  const target: GameTarget = { kind: "game", gameId: GAME_ID };
  const disconnect = lifetime.connect(setup);
  lifetime.activate();
  const previousRender = lifetime.getRouteRevision(setup);
  game(GAME_ID, "recovered");
  const destination = { pathname: "/sandbox/games/" + GAME_ID, search: "" };
  navigation.departing(destination);
  navigation.arrived(destination);
  // React can synchronously render controller state with the old router context.
  expect(lifetime.getRouteRevision(setup)).toBe(previousRender);
  expect(lifetime.getRouteRevision(target)).toBeGreaterThan(previousRender);
  expect(endLifetime).not.toHaveBeenCalled();
  disconnect();
  const leave = lifetime.connect(target);
  expect(lifetime.getSnapshot()).toBe("running");
  expect(endLifetime).not.toHaveBeenCalled();
  leave();
});

it("keeps a late-mounted game stopped when a destination is already pending", () => {
  const navigation = new RouteNavigation();
  navigation.departing({ pathname: "/history", search: "" });
  let entries = 0;
  const lifetime = new GameRouteLifetime(
    "arena",
    () => ({ endLifetime: () => undefined }),
    () => {
      entries++;
    },
    () => undefined,
    navigation,
  );
  const disconnect = lifetime.connect({ kind: "game", gameId: GAME_ID });
  try {
    expect(lifetime.getSnapshot()).toBe("departing");
    lifetime.activate();
    expect(entries).toBe(0);
  } finally {
    disconnect();
  }
});
