import { afterEach, describe, expect, it, vi } from "vitest";

import { createGoogleProvider } from "../src/providers/google.js";
import { createOpenAiProvider } from "../src/providers/openai.js";

import { aiCommand, createAi, post, records, turn } from "./ai-helpers.js";
import { googleModelInfo, googleModels, googleResponse } from "./google-fixtures.js";
import { ApiHarness } from "./helpers.js";
import { openAiModels, openAiResponse } from "./openai-fixtures.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());
const credential = { provider: "google" as const, apiKey: "google-http-key-canary" };
const configuration = {
  provider: "google" as const,
  modelId: googleModelInfo().name,
  parameters: { temperature: 0, maxOutputTokens: 2048, reasoningEffort: "high" },
};

describe("Google through the authorized game service (mock HTTP)", () => {
  it("plays a mixed-provider game with canonical context, retries, private persistence, and deduplication", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(credential.apiKey);
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.includes("models?") ? googleModels() : googleModelInfo(),
        );
      }
      attempts++;
      const body = JSON.parse(init?.body as string) as {
        contents: { parts: { text: string }[] }[];
        generationConfig: Record<string, unknown>;
      };
      const context = JSON.parse(body.contents[0]!.parts[1]!.text) as Record<string, unknown>;
      expect(context.sideToMove).toBe("black");
      expect(context.color).toBe("black");
      expect(context.pgn).toContain("e4");
      expect(context.legalMoves).toContain("e7e5");
      expect(JSON.stringify(body)).not.toContain("Private opponent commentary.");
      expect(JSON.stringify(body)).not.toContain("openai");
      expect(JSON.stringify(body)).not.toContain("gpt-4.1");
      expect(JSON.stringify(body)).not.toContain(credential.apiKey);
      expect(body.generationConfig.temperature).toBe(0);
      expect(body.generationConfig.maxOutputTokens).toBe(2048);
      expect(body.generationConfig.thinkingConfig).toBeUndefined();
      if (attempts === 1) return Response.json(googleResponse({ move: "e7e4" }));
      return Response.json({
        ...googleResponse({ move: "e7e5", commentary: "Black takes the center." }),
        usageMetadata: {
          promptTokenCount: 30,
          candidatesTokenCount: 12,
          totalTokenCount: 50,
          thoughtsTokenCount: 8,
          metadata: credential,
        },
        responseId: "google_integration1",
      });
    });
    const openAiFetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      Response.json(
        init?.method === "GET"
          ? openAiModels()
          : openAiResponse({ move: "e2e4", commentary: "Private opponent commentary." }),
      ),
    );
    const api = await harness.createApi({
      nodeEnv: "production",
      sandboxEnabled: false,
      ai: {
        providers: [
          { adapter: createGoogleProvider({ fetch, now: () => 0 }) },
          { adapter: createOpenAiProvider({ fetch: openAiFetch, now: () => 0 }) },
        ],
      },
    });
    const guest = await harness.guest(api);
    const otherGuest = await harness.guest(api);
    const otherCredential = { provider: "openai" as const, apiKey: "openai-http-key-canary" };
    expect((await post(api, guest, "/ai/models", { credential })).statusCode).toBe(200);
    expect((await post(api, guest, "/ai/models", { credential: otherCredential })).statusCode).toBe(
      200,
    );
    const initial = await createAi(api, guest, {
      mode: "ai_vs_ai",
      white: { provider: "openai", modelId: "gpt-4.1", parameters: {} },
      black: configuration,
    });
    const whiteTurn = await turn(api, guest, aiCommand(initial), otherCredential);
    expect(whiteTurn.statusCode, whiteTurn.body).toBe(200);
    const command = aiCommand(whiteTurn.json());
    expect((await turn(api, otherGuest, command, credential)).statusCode).toBe(404);
    expect(attempts).toBe(0);
    const response = await turn(api, guest, command, credential);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      state: "active",
      version: 2,
      moves: [{ uci: "e2e4" }, { uci: "e7e5" }],
    });
    expect(attempts).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(5);
    const stored = await records(api, initial.gameId);
    expect(
      stored.invocations.filter((invocation) => invocation.provider === "google"),
    ).toMatchObject([
      { status: "model_invalid", attempt: 1, invalidReason: "illegal_move", usageReported: false },
      {
        status: "succeeded",
        attempt: 2,
        move: "e7e5",
        commentary: "Black takes the center.",
        latencyMs: 0,
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 50,
        usageReported: true,
        providerRequestId: "google_integration1",
      },
    ]);
    expect(stored.moves).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain(credential.apiKey);
    expect((await turn(api, guest, command, credential)).statusCode).toBe(409);
    expect(attempts).toBe(2);
    expect(openAiFetch).toHaveBeenCalledTimes(2);
  });

  it("pauses AI-versus-human on an operational failure and accepts explicit retry with a new key", async () => {
    let attempts = 0;
    const keys: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.includes("models?") ? googleModels() : googleModelInfo(),
        );
      }
      keys.push(new Headers(init?.headers).get("x-goog-api-key"));
      attempts++;
      if (attempts === 1) {
        return Response.json({ error: { message: credential.apiKey } }, { status: 429 });
      }
      return Response.json(googleResponse());
    });
    const api = await harness.createApi({
      ai: { providers: [{ adapter: createGoogleProvider({ fetch, now: () => 0 }) }] },
    });
    const guest = await harness.guest(api);
    await post(api, guest, "/ai/models", { credential });
    const initial = await createAi(api, guest, {
      mode: "ai_vs_human",
      humanColor: "black",
      ai: configuration,
    });
    const response = await turn(api, guest, aiCommand(initial), credential);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      state: "paused",
      result: "*",
      terminationReason: null,
      moves: [],
    });
    const stored = await records(api, initial.gameId);
    expect(stored.invocations).toMatchObject([
      { status: "provider_error", errorKind: "provider_quota", invalidReason: null },
    ]);
    expect(stored.invocations).toHaveLength(1);
    expect(attempts).toBe(1);
    const replacement = { ...credential, apiKey: "replacement-google-key-canary" };
    const retry = await turn(api, guest, aiCommand(response.json()), replacement);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ state: "paused", moves: [{ uci: "e2e4" }] });
    expect(keys).toEqual([credential.apiKey, replacement.apiKey]);
    expect(JSON.stringify(await records(api, initial.gameId))).not.toContain("key-canary");
  });

  it("ends in a technical loss after three missing move outputs through the shared policy", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.includes("models?") ? googleModels() : googleModelInfo(),
        );
      }
      attempts++;
      return Response.json({ candidates: [] });
    });
    const api = await harness.createApi({
      ai: { providers: [{ adapter: createGoogleProvider({ fetch, now: () => 0 }) }] },
    });
    const guest = await harness.guest(api);
    await post(api, guest, "/ai/models", { credential });
    const initial = await createAi(api, guest, {
      mode: "ai_vs_ai",
      white: configuration,
      black: configuration,
    });
    const response = await turn(api, guest, aiCommand(initial), credential);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      state: "completed",
      result: "0-1",
      terminationReason: "model_technical_loss",
      moves: [],
    });
    expect(attempts).toBe(3);
    const stored = await records(api, initial.gameId);
    expect(stored.invocations).toHaveLength(3);
    expect(stored.invocations.every((invocation) => invocation.status === "model_invalid")).toBe(
      true,
    );
  });
});
