import type { GameDetails } from "@neurochess/contracts";
import { type LoaderFunction, type RouteObject, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthApi } from "../api/auth-client";
import { RouteNavigation } from "../app/route-navigation";
import { RouteRuntime } from "../app/route-runtime";
import { createAppRoutes } from "../app/routes";
import {
  errorResponse,
  FOOLS_MATE,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock, type HttpRoutes } from "../test/http";

const configuration = {
  mode: "ai_vs_ai",
  seats: {
    white: { type: "ai", provider: "openai", modelId: "fixture", parameters: {} },
    black: { type: "ai", provider: "openai", modelId: "fixture", parameters: {} },
  },
} as const;
const details: GameDetails = { snapshot: snapshot(), configuration };
const account = {
  user: { id: OTHER_GAME_ID, email: "player@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
const profile = {
  username: "Player",
  completed: true,
  avatar: { source: "initials", initials: "PL" },
};
const saved = {
  credentialId: GAME_ID,
  provider: "openai",
  label: "Arena",
  maskedSuffix: "1234",
  createdAt: "2026-10-01T00:00:00.000Z",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  sessionStorage.clear();
});

function routeById(routes: RouteObject[], id: string): RouteObject | undefined {
  for (const route of routes) {
    if (route.id === id) return route;
    if (route.children) {
      const found = routeById(route.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function harness(routes: HttpRoutes = {}) {
  const http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null), ...routes });
  vi.stubGlobal("fetch", http.fetch);
  const runtime = new RouteRuntime(createAuthApi("http://localhost:3001"));
  const navigation = new RouteNavigation();
  const appRoutes = createAppRoutes({
    apiBaseUrl: "http://localhost:3001",
    sandboxEnabled: false,
    runtime,
    navigation,
  });
  cleanups.push(() => {
    runtime.dispose();
    http.assertNoUnexpectedRequests();
  });
  const read = (path: string, signal = new AbortController().signal, gameId?: string) => {
    const route = routeById(appRoutes, gameId === undefined ? "arena-entry" : "arena-game");
    if (!route) throw new Error("Test route missing");
    return (route.loader as LoaderFunction)({
      request: new Request("http://localhost" + path, { signal }),
      params: gameId === undefined ? {} : { gameId },
      context: new RouterContextProvider(),
      url: new URL("http://localhost" + path),
      pattern: gameId === undefined ? "/" : "/games/:gameId",
    });
  };
  return { runtime, navigation, http, read };
}

describe("Arena entry loaders", () => {
  it("discovers setup before rendering, without bootstrapping or recovering an unfinished game", async () => {
    const { read, http } = harness({
      "GET /games/unfinished": () => jsonResponse({ game: details }),
    });
    expect(await read("/")).toMatchObject({
      data: { access: "guest", entry: { kind: "setup", existingGameId: GAME_ID, issue: null } },
    });
    expect(http.fetch.mock.calls.map(([url]) => requestPath(url))).toEqual([
      "/api/auth/get-session",
      "/games/unfinished",
    ]);
  });

  it("treats a missing guest as empty setup without creating a session", async () => {
    const { read } = harness({
      "GET /games/unfinished": () => errorResponse("UNAUTHORIZED", 401),
    });
    expect(await read("/")).toMatchObject({
      data: { entry: { kind: "setup", existingGameId: null, issue: null } },
    });
  });

  it.each(["/?game=", "/?game=" + GAME_ID, "/?game=a&game=b"])(
    "rejects obsolete entry %s before resolving identity",
    async (path) => {
      const { read, http } = harness();
      expect(await read(path)).toBeNull();
      expect(http.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/games/bad", "bad"],
    ["/games/" + GAME_ID + "?game=", GAME_ID],
    ["/games/" + GAME_ID + "/extra", GAME_ID],
    ["/games/" + GAME_ID + "%2Fextra", GAME_ID + "/extra"],
  ])("rejects invalid game target %s without any API calls", async (path, id) => {
    const { read, http } = harness();
    expect(await read(path, undefined, id)).toBeNull();
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it("loads a validated private game with scoped identity and only masked credential metadata", async () => {
    const { read, http, runtime } = harness({
      "GET /api/auth/get-session": () => jsonResponse(account),
      "GET /profile": () => jsonResponse(profile),
      [`GET /games/${GAME_ID}/details`]: () => jsonResponse(details),
      "GET /credentials": () => jsonResponse({ credentials: [saved] }),
    });
    const result = await read("/games/" + GAME_ID.toUpperCase(), undefined, GAME_ID.toUpperCase());
    expect(result).toEqual({
      generation: runtime.account.getSnapshot().revision,
      data: {
        access: "account",
        entry: { kind: "game", gameId: GAME_ID, details },
        credentials: { phase: "ready", credentials: [saved] },
      },
    });
    const request = http.fetch.mock.calls.find(([url]) => requestPath(url).endsWith("/details"));
    expect(new Headers(request?.[1]?.headers).get("x-neurochess-expected-account")).toBe(
      OTHER_GAME_ID,
    );
    expect(http.fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(request?.[1]?.cache).toBe("no-store");
  });

  it.each(["terminal", "sandbox"])(
    "reads %s details without keys, leases or recovery",
    async (kind) => {
      const game = {
        snapshot: kind === "terminal" ? snapshot(FOOLS_MATE) : snapshot(),
        configuration: kind === "sandbox" ? null : configuration,
      };
      const { read } = harness({
        "GET /api/auth/get-session": () => jsonResponse(account),
        "GET /profile": () => jsonResponse(profile),
        [`GET /games/${GAME_ID}/details`]: () => jsonResponse(game),
      });
      expect(await read("/games/" + GAME_ID, undefined, GAME_ID)).toMatchObject({
        data: { entry: { kind: "game", details: game }, credentials: null },
      });
    },
  );

  it("gates a direct game loader before private reads when onboarding is incomplete", async () => {
    const { read } = harness({
      "GET /api/auth/get-session": () => jsonResponse(account),
      "GET /profile": () => jsonResponse({ ...profile, completed: false, username: null }),
    });
    expect(await read("/games/" + GAME_ID, undefined, GAME_ID)).toMatchObject({
      data: { access: "onboarding", entry: null, credentials: null },
    });
  });

  it("aborts route reads and discards late responses without returning private data", async () => {
    const pending = Promise.withResolvers<Response>();
    const { read, http } = harness({ [`GET /games/${GAME_ID}/details`]: () => pending.promise });
    const abort = new AbortController();
    const reading = read("/games/" + GAME_ID, abort.signal, GAME_ID);
    await vi.waitFor(() => expect(http.fetch).toHaveBeenCalledTimes(2));
    const request = http.fetch.mock.calls[1]![1]!;
    abort.abort();
    expect(request.signal?.aborted).toBe(true);
    pending.resolve(jsonResponse(details));
    expect(await reading).toBeNull();
  });

  it("clears issued game data and fences pending results when the identity changes", async () => {
    const pending = Promise.withResolvers<Response>();
    let delayed = false;
    const { read, runtime, http } = harness({
      [`GET /games/${GAME_ID}/details`]: () => (delayed ? pending.promise : jsonResponse(details)),
    });
    const result = await read("/games/" + GAME_ID, undefined, GAME_ID);
    expect(result).toMatchObject({ data: { entry: { details } } });
    delayed = true;
    const reading = read("/games/" + GAME_ID, undefined, GAME_ID);
    await vi.waitFor(() =>
      expect(
        http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/details")),
      ).toHaveLength(2),
    );
    await runtime.account.chooseGuest();
    expect(result).toMatchObject({ data: null });
    pending.resolve(jsonResponse(details));
    expect(await reading).toMatchObject({ data: null });
  });

  it("returns bounded entry failures that can be retried without raw exceptions", async () => {
    const { read } = harness({
      [`GET /games/${GAME_ID}/details`]: () => {
        throw new Error("private-provider-canary");
      },
    });
    const result = await read("/games/" + GAME_ID, undefined, GAME_ID);
    expect(result).toMatchObject({ data: { entry: { kind: "unavailable", code: "unavailable" } } });
    expect(JSON.stringify(result)).not.toContain("private-provider-canary");
  });
});
