import type { AiGameConfiguration, ModelDiscoveryResult } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { createWebI18n } from "../i18n";
import { GAME_ID, jsonResponse, OTHER_GAME_ID, snapshot } from "../test/fixtures";

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
  it("uses the account context without guest bootstrap and cancels on identity loss", async () => {
    const lifetime = new AbortController();
    const pending = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(pending.promise);
    const expired = vi.fn();
    const api = createAiApi("http://localhost:3001", {
      fetch,
      identity: "account",
      lifetime: lifetime.signal,
      onUnauthorized: expired,
    });
    await api.bootstrap(signal());
    expect(fetch).not.toHaveBeenCalled();
    const read = api.unfinished(signal());
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("X-Neurochess-Identity")).toBe(
      "account",
    );
    lifetime.abort();
    pending.resolve(
      jsonResponse({ code: "UNAUTHORIZED", message: "safe", requestId: "request" }, 401),
    );
    await expect(read).rejects.toMatchObject({ kind: "cancelled" });
    expect(expired).not.toHaveBeenCalled();
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
    await api.turn(command, apiKey, signal());
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
      .turn({ ...command, commandId: apiKey }, apiKey, signal())
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
      .turn(command, apiKey, signal())
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
    await expect(api.turn(command, apiKey, signal())).rejects.toMatchObject({
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
      const pending = expect(api.turn(command, apiKey, signal())).rejects.toMatchObject({
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
    const pending = api.turn(command, apiKey, owner.signal);
    owner.abort(apiKey);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    await expect(api.turn(command, apiKey, owner.signal)).rejects.toMatchObject({
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
