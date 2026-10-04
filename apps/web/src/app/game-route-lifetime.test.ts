import { expect, it } from "vitest";

import { GAME_ID } from "../test/fixtures";

import { GameRouteLifetime } from "./game-route-lifetime";
import { RouteNavigation } from "./route-navigation";

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
    expect(lifetime.getSnapshot()).toBe(true);
    lifetime.activate();
    expect(entries).toBe(0);
  } finally {
    disconnect();
  }
});
