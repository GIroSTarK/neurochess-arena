import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAiProvider } from "../src/providers/openai.js";

import { aiCommand, createAi, post, records, turn } from "./ai-helpers.js";
import { anthropicMessage, anthropicModelInfo, anthropicModels } from "./anthropic-fixtures.js";
import { ApiHarness } from "./helpers.js";
import { openAiModels, openAiResponse } from "./openai-fixtures.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());
const credential = { provider: "anthropic" as const, apiKey: "anthropic-http-key-canary" };
const configuration = {
  provider: "anthropic" as const,
  modelId: anthropicModelInfo().id,
  parameters: { temperature: 0, maxOutputTokens: 2048, reasoningEffort: "high" },
};

describe("Anthropic through the authorized game service (mock HTTP)", () => {
  it("plays a mixed-provider game with shared retries, authority, persistence, and deduplication", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe(credential.apiKey);
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.includes("models?")
            ? anthropicModels()
            : anthropicModelInfo(),
        );
      }
      attempts++;
      if (attempts === 1) return Response.json(anthropicMessage("malformed"));
      return Response.json(
        {
          ...anthropicMessage({ move: "e2e4", commentary: "Private viewer commentary." }),
          usage: { input_tokens: 30, output_tokens: 12, metadata: credential },
        },
        { headers: { "request-id": "req_integration1" } },
      );
    });
    const openAiFetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === "GET") return Response.json(openAiModels());
      const body = JSON.parse(init?.body as string) as { input: { content: string }[] };
      const context = JSON.parse(body.input[0]!.content) as Record<string, unknown>;
      expect(context.sideToMove).toBe("black");
      expect(context.pgn).toContain("e4");
      expect(context.legalMoves).toContain("e7e5");
      expect(JSON.stringify(body)).not.toContain("Private viewer commentary.");
      expect(JSON.stringify(body)).not.toContain("anthropic");
      expect(JSON.stringify(body)).not.toContain(configuration.modelId);
      return Response.json(openAiResponse({ move: "e7e5" }));
    });
    const api = await harness.createApi({
      nodeEnv: "production",
      sandboxEnabled: false,
      ai: {
        providers: [
          { adapter: createAnthropicProvider({ fetch, now: () => 0 }) },
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
      white: configuration,
      black: { provider: "openai", modelId: "gpt-4.1", parameters: {} },
    });
    const command = aiCommand(initial);
    expect((await turn(api, otherGuest, command, credential)).statusCode).toBe(404);
    expect(attempts).toBe(0);
    const response = await turn(api, guest, command, credential);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      state: "active",
      version: 1,
      moves: [{ uci: "e2e4" }],
    });
    expect(attempts).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(5);
    const stored = await records(api, initial.gameId);
    expect(stored.invocations).toMatchObject([
      {
        status: "model_invalid",
        attempt: 1,
        invalidReason: "malformed_output",
        usageReported: false,
      },
      {
        status: "succeeded",
        attempt: 2,
        move: "e2e4",
        commentary: "Private viewer commentary.",
        latencyMs: 0,
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: null,
        usageReported: true,
        providerRequestId: "req_integration1",
      },
    ]);
    expect(stored.moves).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(credential.apiKey);
    for (const [, init] of fetch.mock.calls.filter(([, init]) => init?.method === "POST")) {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(2048);
      expect(body.output_config).not.toHaveProperty("effort");
      expect(JSON.stringify(body)).not.toContain(credential.apiKey);
    }
    expect((await turn(api, guest, command, credential)).statusCode).toBe(409);
    expect(attempts).toBe(2);
    const blackTurn = await turn(api, guest, aiCommand(response.json()), otherCredential);
    expect(blackTurn.statusCode, blackTurn.body).toBe(200);
    expect(blackTurn.json()).toMatchObject({
      version: 2,
      moves: [{ uci: "e2e4" }, { uci: "e7e5" }],
    });
    expect(openAiFetch).toHaveBeenCalledTimes(2);
  });

  it("pauses AI-versus-human on a billing failure without consuming invalid attempts", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.includes("models?")
            ? anthropicModels()
            : anthropicModelInfo(),
        );
      }
      attempts++;
      return Response.json(
        { type: "error", error: { type: "billing_error", message: credential.apiKey } },
        { status: 402, headers: { "request-id": "req_billing1" } },
      );
    });
    const api = await harness.createApi({
      ai: { providers: [{ adapter: createAnthropicProvider({ fetch, now: () => 0 }) }] },
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
      {
        status: "provider_error",
        errorKind: "provider_quota",
        invalidReason: null,
        providerRequestId: "req_billing1",
      },
    ]);
    expect(stored.invocations).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(credential.apiKey);
    expect(attempts).toBe(1);
  });

  it("ends in a technical loss after three incomplete model outputs through the shared policy", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.includes("models?")
            ? anthropicModels()
            : anthropicModelInfo(),
        );
      }
      attempts++;
      return Response.json({ ...anthropicMessage(), stop_reason: "max_tokens" });
    });
    const api = await harness.createApi({
      ai: { providers: [{ adapter: createAnthropicProvider({ fetch, now: () => 0 }) }] },
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
