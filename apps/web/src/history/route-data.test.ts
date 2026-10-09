import {
  type ActionFunction,
  type LoaderFunction,
  type RouteObject,
  RouterContextProvider,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthApi } from "../api/auth-client";
import { createAppRoutes } from "../app/routes";
import { RouteNavigation } from "../routing/route-navigation";
import { RouteRuntime } from "../routing/route-runtime";
import { errorResponse, GAME_ID, jsonResponse, OTHER_GAME_ID, requestPath } from "../test/fixtures";
import { createHttpMock, type HttpRoutes } from "../test/http";

const session = {
  user: { id: GAME_ID, email: "player@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
const profile = {
  username: "Player",
  completed: true,
  avatar: { source: "initials", initials: "PL" },
};
const entry = {
  gameId: OTHER_GAME_ID,
  finishedAt: "2026-10-01T12:00:00.123456Z",
  players: { white: { kind: "account", username: "Player" }, black: null },
  configuration: {
    mode: "ai_vs_human",
    seats: {
      white: { type: "human" },
      black: { type: "ai", provider: "openai", modelId: "fixture", parameters: {} },
    },
  },
  state: "aborted",
  result: "*",
  terminationReason: "aborted",
};
const cursor = entry.finishedAt + "_" + OTHER_GAME_ID;
const page = { games: [entry], nextCursor: cursor };
const requestUrl = (input: RequestInfo | URL) =>
  new URL(typeof input === "string" || input instanceof URL ? input : input.url);
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function findHistory(routes: RouteObject[]): RouteObject | undefined {
  for (const route of routes) {
    if (route.id === "history") return route;
    const nested = route.children && findHistory(route.children);
    if (nested) return nested;
  }
}

function harness(overrides: HttpRoutes = {}) {
  const http = createHttpMock({
    "GET /api/auth/get-session": () => jsonResponse(session),
    "GET /profile": () => jsonResponse(profile),
    "GET /games/history?limit=20": () => jsonResponse(page),
    ...overrides,
  });
  vi.stubGlobal("fetch", http.fetch);
  const runtime = new RouteRuntime(createAuthApi("http://localhost:3001"));
  const route = findHistory(
    createAppRoutes({
      apiBaseUrl: "http://localhost:3001",
      sandboxEnabled: false,
      runtime,
      navigation: new RouteNavigation(),
    }),
  )!;
  cleanups.push(() => {
    runtime.dispose();
    http.assertNoUnexpectedRequests();
  });
  const args = (request: Request) => ({
    request,
    params: {},
    context: new RouterContextProvider(),
    url: new URL(request.url),
    pattern: "/history",
  });
  const read = (search = "", signal = new AbortController().signal) =>
    (route.loader as LoaderFunction)(
      args(new Request("http://localhost/history" + search, { signal })),
    );
  const submit = (
    input: Record<string, string> | URLSearchParams,
    signal = new AbortController().signal,
    method = "POST",
  ) => {
    expect(route.action, "History owns its deletion action").toBeTypeOf("function");
    return (route.action as ActionFunction)(
      args(
        new Request("http://localhost/history", {
          method,
          body: new URLSearchParams(input),
          signal,
        }),
      ),
    );
  };
  return { http, runtime, read, submit };
}
const deletion = {
  intent: "delete-game",
  gameId: OTHER_GAME_ID,
  expectedAccount: GAME_ID,
  confirm: "true",
};

describe("History route data", () => {
  it.each(["intent", "expectedAccount", "gameId", "confirm"])(
    "rejects repeated %s fields before resolving identity or deleting history",
    async (field) => {
      const { submit, http } = harness();
      const input = new URLSearchParams(deletion);
      input.append(field, input.get(field)!);
      expect(await submit(input)).toMatchObject({ data: { error: "rejected" } });
      expect(http.fetch).not.toHaveBeenCalled();
    },
  );

  it("loads the newest 20 terminal summaries before render through account/profile authority", async () => {
    const { read, http, runtime } = harness();
    expect(await read()).toEqual({
      generation: runtime.account.getSnapshot().revision,
      data: { access: "account", page, error: false },
    });
    const reads = http.fetch.mock.calls.filter(([url]) => requestPath(url).startsWith("/games/"));
    expect(reads).toHaveLength(1);
    expect(requestUrl(reads[0]![0]).href).toBe("http://localhost:3001/games/history?limit=20");
    expect(reads[0]![1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      headers: { "x-neurochess-expected-account": GAME_ID },
    });
  });

  it("uses the same bounded loader for validated cursors without rounding microseconds", async () => {
    const query = new URLSearchParams({ cursor }).toString();
    const { read } = harness({
      ["GET /games/history?limit=20&" + query]: () => jsonResponse({ games: [], nextCursor: null }),
    });
    expect(await read("?" + query)).toMatchObject({
      data: { page: { games: [], nextCursor: null }, error: false },
    });
  });

  it.each(["?utm_source=x", "?utm_source=x&utm_source=y", "?limit=100", "?owner=" + GAME_ID])(
    "ignores unrelated browser query fields without forwarding them to the API: %s",
    async (query) => {
      const { read } = harness();
      expect(await read(query)).toMatchObject({ data: { page, error: false } });
    },
  );

  it.each(["?cursor=", "?cursor=invalid", "?cursor=a&cursor=b"])(
    "rejects invalid pagination %s before any game read",
    async (query) => {
      const { read, http } = harness();
      expect(await read(query)).toMatchObject({ data: { page: null, error: true } });
      expect(http.fetch.mock.calls.some(([url]) => requestPath(url).startsWith("/games/"))).toBe(
        false,
      );
    },
  );

  it.each(["guest", "required", "onboarding", "unavailable"])(
    "gates %s without private history or deletion requests",
    async (access) => {
      if (access === "required") sessionStorage.setItem("neurochess.account-intent", "account");
      const { read, submit, http } = harness({
        "GET /api/auth/get-session": () => {
          if (access === "unavailable") throw new TypeError("private diagnostic");
          return jsonResponse(access === "onboarding" ? session : null);
        },
        "GET /profile": () => jsonResponse({ ...profile, completed: false, username: null }),
      });
      expect(await read()).toMatchObject({ data: { access, page: null } });
      expect(await submit(deletion)).toMatchObject({ data: { error: "rejected" } });
      expect(http.fetch.mock.calls.some(([url]) => requestPath(url).startsWith("/games/"))).toBe(
        false,
      );
    },
  );

  it("returns a bounded load error, never a raw exception or malformed page", async () => {
    const { read } = harness({
      "GET /games/history?limit=20": () =>
        jsonResponse({ games: [{ ...entry, state: "active" }], nextCursor: null }),
    });
    expect(await read()).toMatchObject({ data: { page: null, error: true } });
  });

  it.each([
    { ...deletion, intent: "delete-account" },
    { ...deletion, gameId: "../history/clear" },
    { ...deletion, confirm: "false" },
    { ...deletion, expectedAccount: OTHER_GAME_ID },
    { intent: "clear-history", confirm: "true", expectedAccount: GAME_ID, gameId: OTHER_GAME_ID },
  ])("rejects an invalid or replacement-account intent without dispatch", async (input) => {
    const { submit, http } = harness();
    expect(await submit(input)).toMatchObject({ data: { error: "rejected" } });
    expect(http.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each(["delete-game", "clear-history"])(
    "acknowledges %s only from a validated response and erases all issued pages",
    async (intent) => {
      const pending = Promise.withResolvers<Response>();
      const query = new URLSearchParams({ cursor }).toString();
      const { read, submit, http } = harness({
        ["GET /games/history?limit=20&" + query]: () => pending.promise,
        ["POST /games/" + OTHER_GAME_ID + "/delete"]: () => jsonResponse({ status: "deleted" }),
        "POST /games/history/clear": () => jsonResponse({ status: "deleted" }),
      });
      const initial = await read();
      const older = read("?" + query);
      await vi.waitFor(() =>
        expect(
          http.fetch.mock.calls.some(([url]) => requestUrl(url).searchParams.has("cursor")),
        ).toBe(true),
      );
      const result = await submit(
        intent === "delete-game" ? deletion : { intent, confirm: "true", expectedAccount: GAME_ID },
      );
      expect(result).toMatchObject({
        data: { success: intent === "delete-game" ? "game" : "history" },
      });
      expect(initial).toMatchObject({ data: { page: null } });
      pending.resolve(jsonResponse(page));
      expect(await older).toMatchObject({ data: { page: null } });
      expect(http.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    },
  );

  it.each([
    ["INVALID_GAME_STATE", "unfinished"],
    ["FORBIDDEN", "rejected"],
    ["NOT_FOUND", "rejected"],
    ["INTERNAL_SERVER_ERROR", "unconfirmed"],
    ["network", "unconfirmed"],
    ["malformed", "unconfirmed"],
  ])(
    "classifies %s without clearing rows, inferring success or retrying",
    async (failure, error) => {
      const { read, submit, http } = harness({
        ["POST /games/" + OTHER_GAME_ID + "/delete"]: () => {
          if (failure === "network") throw new TypeError("private diagnostic");
          if (failure === "malformed") return jsonResponse({});
          return jsonResponse(
            { code: failure, message: "private diagnostic", requestId: "test" },
            400,
          );
        },
      });
      const initial = await read();
      expect(await submit(deletion)).toMatchObject({ data: { error } });
      expect(initial).toMatchObject({ data: { page } });
      expect(http.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    },
  );

  it.each(["read", "delete"])(
    "fences canceled %s responses even if the server finishes",
    async (kind) => {
      const pending = Promise.withResolvers<Response>();
      const { read, submit, http } = harness({
        ...(kind === "read"
          ? { "GET /games/history?limit=20": () => pending.promise }
          : { ["POST /games/" + OTHER_GAME_ID + "/delete"]: () => pending.promise }),
      });
      const abort = new AbortController();
      const operation = kind === "read" ? read("", abort.signal) : submit(deletion, abort.signal);
      await vi.waitFor(() =>
        expect(http.fetch.mock.calls.some(([url]) => requestPath(url).startsWith("/games/"))).toBe(
          true,
        ),
      );
      abort.abort();
      pending.resolve(jsonResponse(kind === "read" ? page : { status: "deleted" }));
      expect(await operation).toBeNull();
    },
  );

  it("clears issued results and late pages when the account changes", async () => {
    let current = session;
    const pending = Promise.withResolvers<Response>();
    const query = new URLSearchParams({ cursor }).toString();
    const { runtime, read, http } = harness({
      "GET /api/auth/get-session": () => jsonResponse(current),
      ["GET /games/history?limit=20&" + query]: () => pending.promise,
    });
    const initial = await read();
    const older = read("?" + query);
    await vi.waitFor(() =>
      expect(
        http.fetch.mock.calls.some(([url]) => requestUrl(url).searchParams.has("cursor")),
      ).toBe(true),
    );
    current = { ...session, user: { ...session.user, id: OTHER_GAME_ID } };
    await runtime.account.refresh();
    expect(initial).toMatchObject({ data: null });
    pending.resolve(jsonResponse(page));
    expect(await older).toMatchObject({ data: null });
  });

  it("does not confirm deletion when the session disappears", async () => {
    const { submit } = harness({
      ["POST /games/" + OTHER_GAME_ID + "/delete"]: () => errorResponse("UNAUTHORIZED", 401),
    });
    expect(JSON.stringify(await submit(deletion))).not.toContain('"success"');
  });

  it("settles cancellation between identity resolution and the History read without an unhandled rejection", async () => {
    const { runtime, read, http } = harness();
    const abort = new AbortController();
    const resolve = runtime.resolvePublicIdentity.bind(runtime);
    vi.spyOn(runtime, "resolvePublicIdentity").mockImplementationOnce(async (...args) => {
      const identity = await resolve(...args);
      abort.abort();
      return identity;
    });
    expect(await read("", abort.signal)).toBeNull();
    expect(http.fetch.mock.calls.some(([url]) => requestPath(url) === "/games/history")).toBe(
      false,
    );
  });

  it.each(["identity", "departure", "pagehide"])(
    "fences a pending deletion after %s without refreshing or retrying",
    async (boundary) => {
      let current = session;
      const pending = Promise.withResolvers<Response>();
      const { runtime, submit, http } = harness({
        "GET /api/auth/get-session": () => jsonResponse(current),
        ["POST /games/" + OTHER_GAME_ID + "/delete"]: () => pending.promise,
      });
      runtime.navigating({ key: "history", pathname: "/history", search: "", hash: "" });
      const deleting = submit(deletion);
      await vi.waitFor(() =>
        expect(http.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
      );
      if (boundary === "identity") {
        current = { ...session, user: { ...session.user, id: OTHER_GAME_ID } };
        await runtime.account.refresh();
      } else if (boundary === "departure") {
        runtime.navigating({ key: "account", pathname: "/account", search: "", hash: "" });
      } else window.dispatchEvent(new Event("pagehide"));
      pending.resolve(jsonResponse({ status: "deleted" }));
      expect(JSON.stringify(await deleting)).not.toContain('"success"');
      expect(http.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(http.fetch.mock.calls.some(([url]) => requestPath(url) === "/games/history")).toBe(
        false,
      );
    },
  );
});
