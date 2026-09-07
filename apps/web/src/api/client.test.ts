import { describe, expect, it, vi } from "vitest";

import { errorResponse, GAME_ID, jsonResponse, OTHER_GAME_ID, snapshot } from "../test/fixtures";

import { ApiFailure, createSandboxApi } from "./client";

describe("sandbox transport boundary", () => {
  it("checks readiness rather than liveness, with bounded, credentialed, no-store requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ status: "ready" }));
    const api = createSandboxApi("http://localhost:3001", { fetch });
    expect(await api.ready(new AbortController().signal)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://localhost:3001/ready"),
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        signal: expect.any(AbortSignal) as unknown,
      }),
    );
  });

  it("accepts the not-ready contract for a 503 response", async () => {
    const api = createSandboxApi("http://localhost:3001", {
      fetch: vi.fn().mockResolvedValue(jsonResponse({ status: "not_ready" }, 503)),
    });
    expect(await api.ready(new AbortController().signal)).toBe(false);
  });

  it.each([
    { status: "surprise" },
    { ...snapshot(), fen: "unsafe-FEN-canary" },
    { ...snapshot(), legalMoves: ["e2e9"] },
    { ...snapshot(), version: -1 },
    { ...snapshot(), turn: "black" },
  ])("rejects malformed snapshots without retaining their content", async (payload) => {
    const api = createSandboxApi("http://localhost:3001", {
      fetch: vi.fn().mockResolvedValue(jsonResponse(payload)),
    });
    await expect(api.create(new AbortController().signal)).rejects.toMatchObject({
      kind: "malformed",
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

  it.each([false, true])(
    "rejects a different game's snapshot, including conflict envelopes",
    async (conflict) => {
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
    },
  );

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

  it("does not acknowledge a late response after its controlling request was cancelled", async () => {
    const body = Promise.withResolvers<unknown>();
    const onResponse = vi.fn();
    const api = createSandboxApi("http://localhost:3001", {
      fetch: vi
        .fn()
        .mockResolvedValue({ ok: true, headers: new Headers(), json: () => body.promise }),
      onResponse,
    });
    const abort = new AbortController();
    const request = api.snapshot(GAME_ID, abort.signal);
    const assertion = expect(request).rejects.toMatchObject({ kind: "cancelled" });
    abort.abort();
    body.resolve(snapshot());
    await assertion;
    expect(onResponse).not.toHaveBeenCalled();
  });
});
