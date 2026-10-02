import type { AiGameConfiguration, ModelDiscoveryResult } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { createWebI18n } from "../i18n";
import {
  errorResponse,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";

import { createAiApi } from "./ai-client";
import { aiRequestMessage, providerFailureMessage } from "./ai-messages";
import { ApiFailure } from "./client";

const apiKey = "web-key-sentinel";
const configuration: AiGameConfiguration = {
  mode: "ai_vs_human",
  seats: {
    white: { type: "ai", provider: "openai", modelId: "dynamic-model", parameters: {} },
    black: { type: "human" },
  },
};
const command = {
  controllerId: GAME_ID,
  gameId: GAME_ID,
  expectedVersion: 0,
  commandId: "303387c5-ff88-4f4c-89ae-db748b55b04a",
};
const signal = () => new AbortController().signal;

describe("AI HTTP client", () => {
  it("validates history responses and sends only account intent and a bounded cursor query", async () => {
    const lifetime = new AbortController();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ games: [], nextCursor: null }));
    const api = createAiApi("https://api.example.test", {
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
      createAiApi("https://api.example.test", { fetch }).history({ limit: 20 }, signal()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("posts scoped history deletions only for accounts and validates their acknowledgement", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse({ status: "deleted" }));
    const api = createAiApi("https://api.example.test", {
      fetch,
      identity: {
        intent: "account",
        expectedAccount: GAME_ID,
        signal: new AbortController().signal,
        verify: async () => undefined,
      },
    });
    await api.deleteHistoryGame(OTHER_GAME_ID, signal());
    await api.clearHistory(signal());
    const [[deleteUrl, deleteInit], [clearUrl, clearInit]] = fetch.mock.calls as [
      [URL, RequestInit],
      [URL, RequestInit],
    ];
    expect(requestPath(deleteUrl)).toBe("/games/history/delete");
    expect(JSON.parse(requestBody(deleteInit))).toEqual({ gameId: OTHER_GAME_ID });
    expect(requestPath(clearUrl)).toBe("/games/history/clear");
    expect(JSON.parse(requestBody(clearInit))).toEqual({ confirm: true });
    for (const init of [deleteInit, clearInit]) {
      expect(init).toMatchObject({ method: "POST", credentials: "include", cache: "no-store" });
      const headers = new Headers(init.headers);
      expect(headers.get("x-neurochess-identity")).toBe("account");
      expect(headers.get("x-neurochess-expected-account")).toBe(GAME_ID);
    }
    fetch.mockResolvedValue(jsonResponse({ status: "deleted", count: 2 }));
    await expect(api.clearHistory(signal())).rejects.toMatchObject({ kind: "malformed" });
    fetch.mockResolvedValue(errorResponse("INVALID_GAME_STATE", 409));
    await expect(api.deleteHistoryGame(GAME_ID, signal())).rejects.toMatchObject({
      kind: "api",
      code: "INVALID_GAME_STATE",
    });
    fetch.mockClear();
    const guest = createAiApi("https://api.example.test", { fetch });
    await expect(guest.deleteHistoryGame(GAME_ID, signal())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(guest.clearHistory(signal())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(api.deleteHistoryGame("not-a-game", signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends only the selected saved reference for discovery and inference", async () => {
    const credentialId = "61111111-1111-4111-8111-111111111111";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, models: [] }))
      .mockResolvedValueOnce(jsonResponse(snapshot()));
    const api = createAiApi("https://api.example.test", { fetch });
    await api.discover({ provider: "openai", credentialId }, signal());
    await api.turn(command, { credentialId }, signal());
    expect(JSON.parse(requestBody(fetch.mock.calls[0]?.[1]))).toEqual({
      provider: "openai",
      credentialId,
    });
    expect(JSON.parse(requestBody(fetch.mock.calls[1]?.[1]))).toEqual({ ...command, credentialId });
  });
  it("skips guest bootstrap for account intent and fences an obsolete response", async () => {
    const lifetime = new AbortController();
    const response = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
    const api = createAiApi("https://api.example.test", {
      fetch,
      identity: { intent: "account", signal: lifetime.signal, verify: async () => undefined },
    });
    await api.bootstrap(signal());
    expect(fetch).not.toHaveBeenCalled();
    const pending = api.unfinished(signal());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-neurochess-identity")).toBe(
      "account",
    );
    lifetime.abort();
    response.resolve(jsonResponse({ game: null }));
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("requires explicit bootstrap and transmits keys only in discovery and inference bodies", async () => {
    const details = { configuration, snapshot: snapshot() };
    const calls: { url: string; body: unknown; init: RequestInit | undefined }[] = [];
    const responses = [
      { status: "ready" },
      { ok: true, models: [] },
      details,
      snapshot(["e2e4"]),
      details,
      { game: details },
      { gameId: GAME_ID, version: 0, turns: [] },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      calls.push({
        url: url instanceof Request ? url.url : String(url),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        init,
      });
      return jsonResponse(responses.shift());
    });
    const api = createAiApi("https://api.example.test", { fetch });
    expect(fetch).not.toHaveBeenCalled();
    await api.bootstrap(signal());
    await api.discover({ provider: "openai", apiKey }, signal());
    await api.create(configuration, signal());
    await api.turn(command, { apiKey }, signal());
    await api.details(GAME_ID, signal());
    await api.unfinished(signal());
    await api.invocations(GAME_ID, signal());
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/guest-session",
      "/providers/models",
      "/games",
      `/games/${GAME_ID}/ai-turn`,
      `/games/${GAME_ID}/details`,
      "/games/unfinished",
      `/games/${GAME_ID}/invocations`,
    ]);
    expect(calls[1]?.body).toEqual({ provider: "openai", apiKey });
    expect(calls[2]?.body).toEqual(configuration);
    expect(calls[3]?.body).toEqual({ ...command, apiKey });
    for (const [index, call] of calls.entries()) {
      expect(call.url).not.toContain(apiKey);
      expect(call.init).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
      if (index !== 1 && index !== 3) expect(JSON.stringify(call)).not.toContain(apiKey);
    }
  });

  it.each([
    { name: "non-local HTTP", origin: "http://api.example.test" },
    { name: "embedded credentials", origin: "https://user:password@example.test" },
    { name: "query string", origin: "https://api.example.test?apiKey=secret" },
    { name: "non-root path", origin: "https://api.example.test/path" },
  ])("rejects unsafe credential destination: $name", ({ origin }) => {
    expect(() => createAiApi(origin)).toThrow(ApiFailure);
  });

  it("rejects malformed requests without retaining keys in validation errors", async () => {
    const fetch = vi.fn();
    const api = createAiApi("http://localhost:3001", { fetch });
    const failure: unknown = await api
      .turn({ ...command, commandId: apiKey }, { apiKey }, signal())
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "malformed" });
    expect(JSON.stringify(failure)).not.toContain(apiKey);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "turn in progress",
      payload: { code: "AI_TURN_IN_PROGRESS", requestId: "request-1" },
      status: 409,
      expected: { code: "AI_TURN_IN_PROGRESS" },
    },
    {
      name: "unauthorized with discarded prose",
      payload: { code: "UNAUTHORIZED", requestId: "request-1", message: apiKey },
      status: 401,
      expected: { code: "UNAUTHORIZED" },
    },
    {
      name: "unrecognized cancellation code",
      payload: { code: "AI_TURN_CANCELLED", requestId: "request-1", message: apiKey },
      status: 409,
      expected: { kind: "malformed" },
    },
    {
      name: "malformed success payload",
      payload: { snapshot: apiKey },
      status: 200,
      expected: { kind: "malformed" },
    },
    {
      name: "credential as error code",
      payload: { code: apiKey },
      status: 500,
      expected: { kind: "malformed" },
    },
  ])("preserves only safe errors: $name", async ({ payload, status, expected }) => {
    const api = createAiApi("https://api.example.test", {
      fetch: vi.fn().mockResolvedValue(jsonResponse(payload, status)),
    });
    const error: unknown = await api
      .turn(command, { apiKey }, signal())
      .catch((error: unknown) => error);
    expect(error).toMatchObject(expected);
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(apiKey);
  });

  it.each([
    { name: "accepted response", conflict: false },
    { name: "conflict response", conflict: true },
  ])("rejects another game's snapshot: $name", async ({ conflict }) => {
    const foreign = snapshot([], { gameId: OTHER_GAME_ID });
    const api = createAiApi("https://api.example.test", {
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          conflict
            ? {
                code: "GAME_CONFLICT",
                requestId: "test",
                message: apiKey,
                currentSnapshot: foreign,
              }
            : foreign,
          conflict ? 409 : 200,
        ),
      ),
    });
    await expect(api.turn(command, { apiKey }, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("uses a 190-second turn transport deadline without automatic retries", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetch = vi.fn<typeof globalThis.fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error(apiKey));
              },
              { once: true },
            );
          }),
      );
      const api = createAiApi("https://api.example.test", { fetch });
      const pending = expect(api.turn(command, { apiKey }, signal())).rejects.toMatchObject({
        kind: "timeout",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(180_000);
      await pending;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels requests when their owner ends and refuses an already-cancelled request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(apiKey)), { once: true });
        }),
    );
    const api = createAiApi("https://api.example.test", { fetch });
    const owner = new AbortController();
    const pending = api.turn(command, { apiKey }, owner.signal);
    owner.abort(apiKey);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    await expect(api.turn(command, { apiKey }, owner.signal)).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("delivers normalized provider codes to the localization boundary", async () => {
    const t = createWebI18n().t;
    for (const code of ["provider_auth", "provider_quota", "provider_timeout"] as const) {
      const response: ModelDiscoveryResult = { ok: false, error: { code } };
      const api = createAiApi("https://api.example.test", {
        fetch: vi.fn().mockResolvedValue(jsonResponse(response)),
      });
      const result = await api.discover({ provider: "openai", apiKey }, signal());
      expect(result).toEqual(response);
      if (result.ok) throw new Error("Expected failure");
      expect(providerFailureMessage(result.error, t)).not.toContain("provider.");
      expect(providerFailureMessage(result.error, t)).not.toContain(apiKey);
    }
    expect(aiRequestMessage("AI_KEY_REQUIRED", t)).toBe(
      "Re-enter the API key for this seat to continue.",
    );
  });
});
