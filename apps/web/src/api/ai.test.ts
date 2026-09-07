import {
  aiRuntimeHeader,
  type CreateAiGameRequest,
  type SessionCredential,
} from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { catalogResponse, models } from "../../../../test/ai-models";
import {
  errorResponse,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  snapshot,
} from "../test/fixtures";

import { createAiSetupApi, createAiTurnApi } from "./ai";

const credential: SessionCredential = { provider: "openai", apiKey: "fixture-memory-only-key" };
const configuration: CreateAiGameRequest = {
  mode: "ai_vs_ai",
  white: { provider: "openai", modelId: "fixture-full", parameters: { temperature: 0 } },
  black: { provider: "openai", modelId: "fixture-full", parameters: {} },
};
const signal = () => new AbortController().signal;

describe("AI turn transport", () => {
  const command = { gameId: GAME_ID, commandId: OTHER_GAME_ID, expectedVersion: 0 };

  it("binds subsequent turns to the API runtime and signals a restart without resending work", async () => {
    const accepted = jsonResponse(snapshot(["e2e4"]));
    accepted.headers.set(aiRuntimeHeader, GAME_ID);
    const restarted = errorResponse("GAME_CONFLICT", 409, snapshot(["e2e4"]));
    restarted.headers.set(aiRuntimeHeader, OTHER_GAME_ID);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(accepted)
      .mockResolvedValueOnce(restarted);
    const api = createAiTurnApi("http://localhost:3001", { fetch });
    await api.turn(command, credential, signal());
    await expect(
      api.turn({ ...command, expectedVersion: 1 }, credential, signal()),
    ).rejects.toMatchObject({ kind: "restart" });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get(aiRuntimeHeader)).toBe(GAME_ID);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a restarted API after an explicit lifecycle response so continuation needs no second recovery", async () => {
    const accepted = jsonResponse(snapshot(["e2e4"]));
    accepted.headers.set(aiRuntimeHeader, OTHER_GAME_ID);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(accepted);
    const api = createAiTurnApi("http://localhost:3001", { fetch });
    api.acknowledgeRuntime?.(GAME_ID);
    api.acknowledgeRuntime?.(OTHER_GAME_ID);
    await expect(api.turn(command, credential, signal())).resolves.toEqual(snapshot(["e2e4"]));
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get(aiRuntimeHeader)).toBe(OTHER_GAME_ID);
  });

  it("waits beyond ten seconds and retains caller cancellation through body consumption", async () => {
    vi.useFakeTimers();
    try {
      const body = Promise.withResolvers<unknown>();
      const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
        init?.signal?.addEventListener("abort", () =>
          body.reject(new Error("secret-network-canary")),
        );
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          json: () => body.promise,
        } as Response);
      });
      const api = createAiTurnApi("http://localhost:3001", { fetch });
      const abort = new AbortController();
      const pending = api.turn(command, credential, abort.signal);
      const checked = expect(pending).rejects.toMatchObject({
        kind: "cancelled",
        message: "cancelled",
      });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      expect(fetch.mock.calls[0]).toEqual([
        new URL(`http://localhost:3001/games/${GAME_ID}/ai-turn`),
        expect.objectContaining({
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers: { accept: "application/json", "content-type": "application/json" },
        }),
      ]);
      expect(JSON.parse(requestBody(fetch.mock.calls[0]?.[1])) as unknown).toEqual({
        ...command,
        credential,
      });
      abort.abort();
      await checked;
      expect(credential.apiKey).toBe("fixture-memory-only-key");
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates requests, snapshots and conflict ownership", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(snapshot(["e2e4"])));
    const api = createAiTurnApi("http://localhost:3001", { fetch });
    await expect(
      api.turn({ ...command, commandId: "invalid" }, credential, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await api.turn(command, credential, signal())).toEqual(snapshot(["e2e4"]));
    fetch.mockResolvedValueOnce(errorResponse("GAME_CONFLICT", 409, snapshot()));
    await expect(api.turn(command, credential, signal())).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: snapshot(),
    });
    fetch.mockResolvedValueOnce(
      errorResponse("GAME_CONFLICT", 409, snapshot([], { gameId: OTHER_GAME_ID })),
    );
    await expect(api.turn(command, credential, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
  });
});

describe("AI setup transport", () => {
  it("validates private configuration reads and rejects credentials, catalog references and foreign snapshots", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ snapshot: snapshot(), configuration }));
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    expect(await api.game(GAME_ID, signal())).toEqual({ snapshot: snapshot(), configuration });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "include",
      cache: "no-store",
    });
    for (const invalid of [
      { snapshot: snapshot([], { gameId: OTHER_GAME_ID }), configuration },
      {
        snapshot: snapshot(),
        configuration: { ...configuration, white: { ...configuration.white, apiKey: "secret" } },
      },
      {
        snapshot: snapshot(),
        configuration: {
          ...configuration,
          black: { ...configuration.black, catalogId: OTHER_GAME_ID },
        },
      },
    ]) {
      fetch.mockResolvedValueOnce(jsonResponse(invalid));
      await expect(api.game(GAME_ID, signal())).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  it("sends a credential-free versioned pause on page exit using keepalive", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 })),
      );
    const api = createAiTurnApi("http://localhost:3001", { fetch });
    const command = {
      action: "pause",
      gameId: GAME_ID,
      commandId: OTHER_GAME_ID,
      expectedVersion: 0,
    } as const;
    api.leave?.(command);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ keepalive: true, credentials: "include" });
    expect(JSON.parse(requestBody(fetch.mock.calls[0]?.[1])) as unknown).toEqual(command);
  });
  it("sends credentials only in a no-store, credentialed discovery POST body", async () => {
    const discovered = catalogResponse();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(discovered));
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    expect(await api.discover(credential, signal())).toEqual(discovered);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([
      new URL("http://localhost:3001/ai/models"),
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        redirect: "error",
        credentials: "include",
        body: JSON.stringify({ credential }),
        headers: { accept: "application/json", "content-type": "application/json" },
      }),
    ]);
    expect(credential.apiKey).toBe("fixture-memory-only-key");
  });

  it.each([
    { ...catalogResponse(), value: models("anthropic") },
    { ...catalogResponse(), value: [models()[0], models()[0]] },
    {
      ...catalogResponse(),
      value: models().map((model) => ({ ...model, name: credential.apiKey })),
    },
    { ...catalogResponse(), catalogId: "not-a-catalog" },
    { ok: true, value: models() },
    { ok: false, error: { kind: "provider_auth", message: credential.apiKey } },
  ])(
    "rejects invalid or credential-bearing discovery results without retaining diagnostics",
    async (payload) => {
      const api = createAiSetupApi("http://localhost:3001", {
        fetch: vi.fn().mockResolvedValue(jsonResponse(payload)),
      });
      await expect(api.discover(credential, signal())).rejects.toMatchObject({
        kind: "malformed",
        message: "malformed",
      });
    },
  );

  it("sends the previous catalog only for explicit refresh and returns its replacement reference", async () => {
    const previous = catalogResponse();
    const next = catalogResponse();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(next));
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    expect(await api.discover(credential, signal(), previous.catalogId)).toEqual(next);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ credential, catalogId: previous.catalogId }),
    );
  });

  it("rejects keys in configuration before creating a game and sends only validated configuration", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(snapshot(), 201));
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    const unsafe = { ...configuration, credential };
    await expect(api.create(unsafe, signal())).rejects.toMatchObject({ kind: "malformed" });
    expect(fetch).not.toHaveBeenCalled();
    await api.create(configuration, signal());
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(configuration));
  });

  it("does not send malformed keys or duplicate providers through the boundary", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        providers: [
          { id: "openai", name: "OpenAI" },
          { id: "openai", name: "Duplicate" },
        ],
      }),
    );
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    await expect(
      api.discover({ ...credential, apiKey: "has whitespace" }, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.providers(signal())).rejects.toMatchObject({ kind: "malformed" });
  });

  it("preserves authorized creation conflicts and discards server message fields", async () => {
    const api = createAiSetupApi("http://localhost:3001", {
      fetch: vi.fn().mockResolvedValue(errorResponse("GAME_CONFLICT", 409, snapshot())),
    });
    await expect(api.create(configuration, signal())).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: snapshot(),
      message: "api",
    });
  });
});
