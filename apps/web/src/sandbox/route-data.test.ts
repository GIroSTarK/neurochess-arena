import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteNavigation } from "../routing/route-navigation";
import { errorResponse, GAME_ID, jsonResponse, requestPath, snapshot } from "../test/fixtures";
import { createHttpMock, type HttpRoutes } from "../test/http";

import { sandboxEntryLoader, sandboxGameLoader } from "./route-data";

const gamePath = "/sandbox/games/" + GAME_ID;
const apiPath = "/games/" + GAME_ID;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function harness(routes: HttpRoutes = {}, sandboxEnabled = true) {
  const http = createHttpMock(routes);
  vi.stubGlobal("fetch", http.fetch);
  cleanups.push(() => http.assertNoUnexpectedRequests());
  const navigation = new RouteNavigation();
  const context = { apiBaseUrl: "http://localhost:3001", sandboxEnabled, navigation };
  const entry = sandboxEntryLoader(context);
  const game = sandboxGameLoader(context);
  const read = (path: string, gameId?: string, signal = new AbortController().signal) => {
    const url = new URL(path, "http://localhost");
    return (gameId === undefined ? entry : game).loader({
      request: new Request(url, { signal }),
      params: gameId === undefined ? {} : { gameId },
      context: new RouterContextProvider(),
      url,
      pattern: gameId === undefined ? "/sandbox" : "/sandbox/games/:gameId",
    });
  };
  return { http, navigation, read, game };
}

describe("Sandbox entry loaders", () => {
  it.each([
    ["/sandbox?game="],
    ["/sandbox?game=" + GAME_ID + "&game="],
    [gamePath + "?game=", GAME_ID],
    ["/sandbox/games/invalid", "invalid"],
    [gamePath + "%2fextra", GAME_ID + "/extra"],
    [gamePath + "/extra", GAME_ID],
    ["/SANDBOX/games/" + GAME_ID, GAME_ID],
  ])("rejects %s before readiness or game reads", async (path, gameId?: string) => {
    const { read, http } = harness();
    expect(await read(path, gameId)).toBeNull();
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each(["context", "build"])(
    "does not request disabled Sandbox data (%s flag)",
    async (flag) => {
      if (flag === "build") vi.stubEnv("SANDBOX_ENABLED", "false");
      const { read, http } = harness({}, flag !== "context");
      expect(await read("/sandbox")).toBeNull();
      expect(await read(gamePath, GAME_ID)).toBeNull();
      expect(http.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([GAME_ID, GAME_ID.toUpperCase()])(
    "validates %s and reads once without lifecycle writes",
    async (gameId) => {
      const { read, http } = harness({
        "GET /ready": () => jsonResponse({ status: "ready" }),
        [`GET ${apiPath}`]: () => jsonResponse(snapshot()),
      });
      expect(await read("/sandbox/games/" + gameId + "/", gameId)).toEqual({
        kind: "entry",
        entry: { target: { kind: "game", gameId: GAME_ID }, snapshot: snapshot(), readiness: true },
      });
      expect(http.fetch.mock.calls.map(([url]) => requestPath(url))).toEqual(["/ready", apiPath]);
      for (const [, init] of http.fetch.mock.calls) {
        expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
        expect(new Headers(init?.headers).has("x-neurochess-expected-account")).toBe(false);
      }
    },
  );

  it("reads readiness and unfinished discovery concurrently without bootstrapping or pausing", async () => {
    const ready = Promise.withResolvers<Response>();
    const { read, http } = harness({
      "GET /ready": () => ready.promise,
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: snapshot() }),
    });
    const result = read("/sandbox");
    expect(http.fetch.mock.calls.map(([url]) => requestPath(url))).toEqual([
      "/ready",
      "/sandbox/games/unfinished",
    ]);
    ready.resolve(jsonResponse({ status: "ready" }));
    expect(await result).toMatchObject({ kind: "entry", entry: { snapshot: snapshot() } });
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "retains a linked game's %s denial without bootstrapping",
    async (code) => {
      const { read } = harness({
        "GET /ready": () => jsonResponse({ status: "ready" }),
        [`GET ${apiPath}`]: () => errorResponse(code, 403),
      });
      const data = await read(gamePath, GAME_ID);
      expect(data).toMatchObject({
        kind: "entry",
        entry: { issue: { phase: "access-error", notice: code } },
      });
      expect(JSON.stringify(data)).not.toContain("server-message-canary");
    },
  );

  it("keeps missing-guest discovery empty but shows disabled API discovery as unavailable", async () => {
    let code = "UNAUTHORIZED";
    const { read } = harness({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => errorResponse(code, 401),
    });
    expect(await read("/sandbox")).toMatchObject({
      kind: "entry",
      entry: { snapshot: null, readiness: true },
    });
    code = "NOT_FOUND";
    expect(await read("/sandbox")).toMatchObject({
      kind: "entry",
      entry: { issue: { phase: "unavailable", notice: "sandbox-unavailable" } },
    });
  });

  it("normalizes malformed snapshots and readiness failures into bounded values", async () => {
    const { read } = harness({
      "GET /ready": () => {
        throw new Error("private-ready-canary");
      },
      [`GET ${apiPath}`]: () => jsonResponse({ private: "private-record-canary" }),
    });
    expect(await read(gamePath, GAME_ID)).toEqual({
      kind: "entry",
      entry: {
        target: { kind: "game", gameId: GAME_ID },
        readiness: false,
        snapshot: null,
        issue: { phase: "recovery-required", notice: "malformed" },
      },
    });
  });

  it("cancels both parallel reads and discards their late values", async () => {
    const response = Promise.withResolvers<Response>();
    const ready = Promise.withResolvers<Response>();
    const abort = new AbortController();
    const { read, http } = harness({
      "GET /ready": () => ready.promise,
      [`GET ${apiPath}`]: () => response.promise,
    });
    const result = read(gamePath, GAME_ID, abort.signal);
    abort.abort();
    expect(http.fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    response.resolve(jsonResponse(snapshot()));
    ready.resolve(jsonResponse({ status: "ready" }));
    expect(await result).toBeNull();
    expect(await read(gamePath, GAME_ID, abort.signal)).toBeNull();
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses only a live owner's handoff to skip entry reads", async () => {
    const { read, http, navigation } = harness();
    const unregister = navigation.register({
      accepts: (url) => url.pathname === gamePath,
      hasHandoff: (url) => url.pathname === gamePath,
      depart: () => undefined,
    });
    expect(await read(gamePath, GAME_ID)).toEqual({ kind: "handoff", gameId: GAME_ID });
    expect(http.fetch).not.toHaveBeenCalled();
    unregister();
  });
});
