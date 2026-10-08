import { describe, expect, it, vi } from "vitest";

import {
  errorResponse,
  FOOLS_MATE,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  snapshot,
} from "../test/fixtures";

import { ApiFailure, createSandboxApi, type SandboxApi } from "./client";

interface RequestContract {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  payload: unknown;
  status?: number;
  result: unknown;
  invoke: (api: SandboxApi, signal: AbortSignal) => Promise<unknown>;
}

describe("sandbox transport boundary", () => {
  describe("successful request contracts", () => {
    const current = snapshot([], { gameId: OTHER_GAME_ID, version: 7 });
    const moved = snapshot(["e2e4"], { gameId: OTHER_GAME_ID, version: 8 });
    const paused = snapshot([], {
      gameId: OTHER_GAME_ID,
      state: "paused",
      legalMoves: [],
      version: 8,
    });
    const terminal = snapshot(FOOLS_MATE, { gameId: OTHER_GAME_ID });
    const replay = { snapshot: terminal, initialFen: current.fen };
    const pgn = { gameId: terminal.gameId, version: terminal.version, pgn: terminal.pgn };
    const command = {
      gameId: OTHER_GAME_ID,
      expectedVersion: current.version,
      commandId: "57e9326d-dba5-4593-9b92-12d7919d50d1",
    };
    const move = { ...command, move: "e2e4" };
    const pause = { ...command, action: "pause" } as const;
    const requests: Record<keyof SandboxApi, RequestContract> = {
      ready: {
        method: "GET",
        path: "/ready",
        payload: { status: "ready" },
        result: true,
        invoke: (api, signal) => api.ready(signal),
      },
      bootstrap: {
        method: "POST",
        path: "/guest-session",
        body: {},
        payload: { status: "ready" },
        result: undefined,
        invoke: (api, signal) => api.bootstrap(signal),
      },
      create: {
        method: "POST",
        path: "/sandbox/games",
        body: {},
        payload: snapshot(),
        status: 201,
        result: snapshot(),
        invoke: (api, signal) => api.create(signal),
      },
      snapshot: {
        method: "GET",
        path: `/games/${OTHER_GAME_ID}`,
        payload: current,
        result: current,
        invoke: (api, signal) => api.snapshot(OTHER_GAME_ID, signal),
      },
      move: {
        method: "POST",
        path: `/games/${OTHER_GAME_ID}/moves`,
        body: move,
        payload: moved,
        result: moved,
        invoke: (api, signal) => api.move(move, signal),
      },
      lifecycle: {
        method: "POST",
        path: `/games/${OTHER_GAME_ID}/lifecycle`,
        body: pause,
        payload: paused,
        result: paused,
        invoke: (api, signal) => api.lifecycle(pause, signal),
      },
      unfinished: {
        method: "GET",
        path: "/sandbox/games/unfinished",
        payload: { snapshot: current },
        result: current,
        invoke: (api, signal) => api.unfinished(signal),
      },
      replay: {
        method: "GET",
        path: `/games/${OTHER_GAME_ID}/replay`,
        payload: replay,
        result: replay,
        invoke: (api, signal) => api.replay(OTHER_GAME_ID, signal),
      },
      pgn: {
        method: "GET",
        path: `/games/${OTHER_GAME_ID}/pgn`,
        payload: pgn,
        result: pgn,
        invoke: (api, signal) => api.pgn(OTHER_GAME_ID, signal),
      },
    };

    it.each(Object.entries(requests))(
      "%s sends the exact endpoint, method, JSON body, and credentialed request options",
      async (_name, { method, path, body, payload, status = 200, result, invoke }) => {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(jsonResponse(payload, status));
        const origin = "https://api.neurochess.test:8443";
        const api = createSandboxApi(origin, { fetch });

        expect(await invoke(api, new AbortController().signal)).toEqual(result);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(new URL(path, origin), {
          method,
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: expect.any(String) as unknown }),
          signal: expect.any(AbortSignal) as unknown,
        });
        if (body !== undefined) {
          expect(JSON.parse(requestBody(fetch.mock.calls[0]?.[1]))).toEqual(body);
        }
      },
    );
  });

  it("accepts the not-ready contract for a 503 response", async () => {
    const api = createSandboxApi("http://localhost:3001", {
      fetch: vi.fn().mockResolvedValue(jsonResponse({ status: "not_ready" }, 503)),
    });
    expect(await api.ready(new AbortController().signal)).toBe(false);
  });

  describe.each([
    {
      path: "direct",
      current: snapshot(["e2e4"]),
      respond: (payload: unknown) => jsonResponse(payload),
      invoke: (api: SandboxApi, signal: AbortSignal) => api.snapshot(GAME_ID, signal),
    },
    {
      path: "conflict",
      current: snapshot(["e2e4"]),
      respond: (payload: unknown) =>
        jsonResponse(
          {
            code: "GAME_CONFLICT",
            message: "server-message-canary",
            requestId: "test-request",
            currentSnapshot: payload,
          },
          409,
        ),
      invoke: (api: SandboxApi, signal: AbortSignal) => api.snapshot(GAME_ID, signal),
    },
    {
      path: "unfinished",
      current: snapshot(["e2e4"]),
      respond: (payload: unknown) => jsonResponse({ snapshot: payload }),
      invoke: (api: SandboxApi, signal: AbortSignal) => api.unfinished(signal),
    },
    {
      path: "replay",
      current: snapshot(FOOLS_MATE),
      respond: (payload: unknown) =>
        jsonResponse({ snapshot: payload, initialFen: snapshot().fen }),
      invoke: (api: SandboxApi, signal: AbortSignal) => api.replay(GAME_ID, signal),
    },
  ])("$path snapshot validation", ({ current, respond, invoke }) => {
    it.each([
      { issue: "malformed display FEN", patch: { fen: "unsafe-FEN-canary" } },
      {
        issue: "FEN/turn mismatch",
        patch: { turn: current.turn === "white" ? "black" : "white" },
      },
      { issue: "invalid move syntax", patch: { legalMoves: ["e2e9"] } },
      { issue: "negative revision", patch: { version: -1 } },
      {
        issue: "invalid nested history",
        patch: { moves: current.moves.map((move) => ({ ...move, ply: 0 })) },
      },
      { issue: "unknown field", patch: { status: "surprise" } },
    ])("rejects $issue without retaining response content", async ({ patch }) => {
      const payload = { ...current, ...patch, pgn: "private-snapshot-canary" };
      const api = createSandboxApi("http://localhost:3001", {
        fetch: vi.fn().mockResolvedValue(respond(payload)),
      });
      const error: unknown = await invoke(api, new AbortController().signal).catch(
        (error: unknown) => error,
      );

      expect(error).toBeInstanceOf(ApiFailure);
      expect(error).toMatchObject({
        kind: "malformed",
        message: "malformed",
        code: undefined,
        currentSnapshot: undefined,
      });
      expect(JSON.stringify(error)).not.toContain("canary");
      expect(String(error)).not.toContain("canary");
    });
  });

  it("accepts discovery with no unfinished game", async () => {
    const api = createSandboxApi("http://localhost:3001", {
      fetch: vi.fn().mockResolvedValue(jsonResponse({ snapshot: null })),
    });
    await expect(api.unfinished(new AbortController().signal)).resolves.toBeNull();
  });

  it.each([
    { issue: "missing snapshot", payload: {} },
    { issue: "terminal snapshot", payload: { snapshot: snapshot(FOOLS_MATE) } },
  ])("rejects unfinished discovery with $issue", async ({ payload }) => {
    const api = createSandboxApi("http://localhost:3001", {
      fetch: vi.fn().mockResolvedValue(jsonResponse(payload)),
    });
    await expect(api.unfinished(new AbortController().signal)).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  describe("replay envelope validation", () => {
    const terminal = snapshot(FOOLS_MATE);
    const replay = { snapshot: terminal, initialFen: snapshot().fen };

    it.each([
      { issue: "missing initial FEN", payload: { snapshot: terminal } },
      { issue: "unfinished snapshot", payload: { ...replay, snapshot: snapshot() } },
      {
        issue: "different game's snapshot",
        payload: { ...replay, snapshot: { ...terminal, gameId: OTHER_GAME_ID } },
      },
      { issue: "malformed initial FEN", payload: { ...replay, initialFen: "invalid" } },
      {
        issue: "malformed historical FEN",
        payload: {
          ...replay,
          snapshot: {
            ...terminal,
            moves: terminal.moves.map((move) =>
              move.ply === 2 ? { ...move, fen: "invalid" } : move,
            ),
          },
        },
      },
    ])("rejects $issue", async ({ payload }) => {
      const api = createSandboxApi("http://localhost:3001", {
        fetch: vi.fn().mockResolvedValue(jsonResponse(payload)),
      });
      await expect(api.replay(GAME_ID, new AbortController().signal)).rejects.toMatchObject({
        kind: "malformed",
      });
    });
  });

  it("discards server prose while preserving an authorized conflict snapshot", async () => {
    const current = snapshot(["e2e4"]);
    const api = createSandboxApi("http://localhost:3001", {
      fetch: vi.fn().mockResolvedValue(errorResponse("GAME_CONFLICT", 409, current)),
    });
    const error: unknown = await api
      .snapshot(GAME_ID, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: current });
    expect(JSON.stringify(error)).not.toContain("server-message-canary");
    expect(String(error)).not.toContain("server-message-canary");
  });

  it.each([
    { name: "accepted response", conflict: false },
    { name: "conflict response", conflict: true },
  ])("rejects another game's snapshot: $name", async ({ conflict }) => {
    const foreign = snapshot([], { gameId: OTHER_GAME_ID });
    const api = createSandboxApi("http://localhost:3001", {
      fetch: vi
        .fn()
        .mockResolvedValue(
          conflict ? errorResponse("GAME_CONFLICT", 409, foreign) : jsonResponse(foreign),
        ),
    });
    await expect(api.snapshot(GAME_ID, new AbortController().signal)).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("rejects invalid requests before fetch", async () => {
    const fetch = vi.fn();
    const api = createSandboxApi("http://localhost:3001", { fetch });
    await expect(api.snapshot("../../secret", new AbortController().signal)).rejects.toBeInstanceOf(
      ApiFailure,
    );
    await expect(
      api.move(
        { gameId: GAME_ID, expectedVersion: 0, commandId: "invalid", move: "e2e4" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ApiFailure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects HTML, broken JSON, and unknown error codes safely", async () => {
    for (const response of [
      new Response("<html>secret-canary</html>", { status: 502 }),
      errorResponse("SECRET_CANARY", 400),
      jsonResponse({ code: "GAME_CONFLICT", message: "secret-canary", requestId: "one" }, 409),
    ]) {
      const api = createSandboxApi("http://localhost:3001", {
        fetch: vi.fn().mockResolvedValue(response),
      });
      await expect(api.create(new AbortController().signal)).rejects.toMatchObject({
        kind: "malformed",
        message: "malformed",
      });
    }
  });

  it("aborts on timeout without exposing exceptions", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("secret-network-canary")),
            );
          }),
      );
      const api = createSandboxApi("http://localhost:3001", { fetch, timeoutMs: 25 });
      const request = api.create(new AbortController().signal);
      const assertion = expect(request).rejects.toMatchObject({
        kind: "timeout",
        message: "timeout",
      });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates cancellation and removes the timeout", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    );
    const api = createSandboxApi("http://localhost:3001", { fetch });
    const abort = new AbortController();
    const request = api.create(abort.signal);
    abort.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled" });
  });
});
