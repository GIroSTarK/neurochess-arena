import { describe, expect, it, vi } from "vitest";

import {
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";

import { ApiFailure } from "./failures";
import { createPublicGameApi } from "./public-game-client";

const origin = "https://api.example.test";
const signal = () => new AbortController().signal;
const account = () => ({
  intent: "account" as const,
  expectedAccount: GAME_ID,
  signal: signal(),
  verify: async () => undefined,
});
const details = () => ({ configuration: null, snapshot: snapshot() });

describe("public game HTTP client", () => {
  it("validates history responses and sends only account intent and a bounded cursor query", async () => {
    const lifetime = new AbortController();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ games: [], nextCursor: null }));
    const api = createPublicGameApi("https://api.example.test", {
      fetch,
      identity: {
        intent: "account",
        expectedAccount: GAME_ID,
        signal: lifetime.signal,
        verify: async () => undefined,
      },
    });
    const cursor = "2026-10-01T00:00:00.123456Z_" + GAME_ID;
    expect(await api.history({ limit: 20, cursor }, signal())).toEqual({
      games: [],
      nextCursor: null,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(url instanceof Request ? url.url : url).searchParams.get("cursor")).toBe(cursor);
    expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
    expect(new Headers(init?.headers).get("x-neurochess-expected-account")).toBe(GAME_ID);
    expect(init?.body).toBeUndefined();
    fetch.mockResolvedValue(jsonResponse({ games: [], nextCursor: "unbounded" }));
    await expect(api.history({ limit: 20 }, signal())).rejects.toMatchObject({ kind: "malformed" });
    await expect(
      createPublicGameApi("https://api.example.test", { fetch }).history({ limit: 20 }, signal()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("reads private details and unfinished games with explicit identity headers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(details()))
      .mockResolvedValueOnce(jsonResponse({ game: details() }))
      .mockResolvedValueOnce(jsonResponse({ game: null }));
    const verify = vi.fn(async () => undefined);
    const api = createPublicGameApi(origin, { fetch, identity: { ...account(), verify } });
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.details(GAME_ID.toUpperCase(), signal())).resolves.toEqual(details());
    await expect(api.unfinished(signal())).resolves.toEqual(details());
    await expect(api.unfinished(signal())).resolves.toBeNull();
    expect(fetch.mock.calls.map(([url]) => requestPath(url))).toEqual([
      `/games/${GAME_ID}/details`,
      "/games/unfinished",
      "/games/unfinished",
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(new Headers(init?.headers).get("x-neurochess-identity")).toBe("account");
      expect(new Headers(init?.headers).get("x-neurochess-expected-account")).toBe(GAME_ID);
      expect(init?.body).toBeUndefined();
    }
    expect(verify).toHaveBeenCalledTimes(6);
  });

  it("keeps guest discovery read-only and refuses account history operations locally", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ game: null }));
    const api = createPublicGameApi(origin, { fetch });
    await expect(api.unfinished(signal())).resolves.toBeNull();
    expect(requestPath(fetch.mock.calls[0]![0])).toBe("/games/unfinished");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-neurochess-identity")).toBe(
      "guest",
    );
    await expect(api.history({ limit: 20 }, signal())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(api.deleteGame(GAME_ID, signal())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(api.clearHistory(signal())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("validates deletion acknowledgements and sends confirmed POST bodies without retries", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse({ status: "deleted" }));
    const api = createPublicGameApi(origin, { fetch, identity: account() });
    await expect(api.deleteGame(GAME_ID.toUpperCase(), signal())).resolves.toEqual({
      status: "deleted",
    });
    await expect(api.clearHistory(signal())).resolves.toEqual({ status: "deleted" });
    expect(fetch.mock.calls.map(([url]) => requestPath(url))).toEqual([
      `/games/${GAME_ID}/delete`,
      "/games/history/clear",
    ]);
    expect(JSON.parse(requestBody(fetch.mock.calls[0]?.[1]))).toEqual({
      gameId: GAME_ID.toUpperCase(),
      confirm: true,
    });
    expect(JSON.parse(requestBody(fetch.mock.calls[1]?.[1]))).toEqual({ confirm: true });
    expect(fetch.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
    fetch.mockResolvedValue(jsonResponse({ status: "unknown" }));
    await expect(api.clearHistory(signal())).rejects.toMatchObject({ kind: "malformed" });
    fetch.mockRejectedValue(new Error("private-canary"));
    await expect(api.deleteGame(GAME_ID, signal())).rejects.toMatchObject({ kind: "network" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid input before dispatch and foreign or inconsistent game details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = createPublicGameApi(origin, { fetch, identity: account() });
    await expect(api.details("private-canary", signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    await expect(api.deleteGame("private-canary", signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    await expect(
      api.history({ limit: 20, cursor: "private-canary" }, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(
      jsonResponse({ ...details(), snapshot: snapshot([], { gameId: OTHER_GAME_ID }) }),
    );
    await expect(api.details(GAME_ID, signal())).rejects.toMatchObject({ kind: "malformed" });
    fetch.mockResolvedValue(
      jsonResponse({ game: { ...details(), snapshot: { ...snapshot(), turn: "black" } } }),
    );
    await expect(api.unfinished(signal())).rejects.toMatchObject({ kind: "malformed" });
  });

  it.each(["UNAUTHORIZED", "PROFILE_REQUIRED", "NOT_FOUND"])(
    "preserves access-loss classification for %s without retaining server prose",
    async (code) => {
      const lost = vi.fn();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          jsonResponse({ code, requestId: "request", message: "private-canary" }, 403),
        );
      const api = createPublicGameApi(origin, { fetch, identity: { ...account(), lost } });
      const error: unknown = await api.details(GAME_ID, signal()).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ApiFailure);
      expect(error).toMatchObject({ kind: "api", code });
      expect(JSON.stringify(error)).not.toContain("private-canary");
      expect(lost).toHaveBeenCalledTimes(code === "NOT_FOUND" ? 0 : 1);
    },
  );

  it.each(["caller", "identity"] as const)(
    "fences a late response after %s cancellation",
    async (owner) => {
      const caller = new AbortController();
      const lifetime = new AbortController();
      const response = Promise.withResolvers<Response>();
      const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
      const api = createPublicGameApi(origin, {
        fetch,
        identity: { ...account(), signal: lifetime.signal },
      });
      const pending = api.details(GAME_ID, caller.signal);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      (owner === "caller" ? caller : lifetime).abort();
      response.resolve(jsonResponse(details()));
      await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await expect(api.details(GAME_ID, caller.signal)).rejects.toMatchObject({
        kind: "cancelled",
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});
