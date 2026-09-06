import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiProvider } from "../src/providers/openai.js";

import { aiCommand, createAi, post, records, turn } from "./ai-helpers.js";
import { ApiHarness } from "./helpers.js";
import { openAiModels, openAiResponse } from "./openai-fixtures.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());
const credential = { provider: "openai" as const, apiKey: "openai-http-key-canary" };
const configuration = {
  provider: "openai" as const,
  modelId: "gpt-4.1",
  parameters: { temperature: 0, reasoningEffort: "high" },
};

describe("OpenAI through the authorized game service (mock HTTP)", () => {
  it("discovers capabilities, retries only invalid output, and persists a single legal move and safe telemetry", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(openAiModels()))
      .mockResolvedValueOnce(Response.json(openAiResponse("malformed")))
      .mockResolvedValueOnce(
        Response.json({
          ...openAiResponse({ move: "e2e4", commentary: null }),
          id: "resp_integration1",
          usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42, metadata: credential },
        }),
      );
    const adapter = createOpenAiProvider({ fetch, now: () => 0 });
    const api = await harness.createApi({
      nodeEnv: "production",
      sandboxEnabled: false,
      ai: { providers: [{ adapter }] },
    });
    const guest = await harness.guest(api);
    expect((await post(api, guest, "/ai/models", { credential })).statusCode).toBe(200);
    const initial = await createAi(api, guest, {
      mode: "ai_vs_ai",
      white: configuration,
      black: configuration,
    });
    const command = aiCommand(initial);
    const response = await turn(api, guest, command, credential);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      state: "active",
      version: 1,
      moves: [{ uci: "e2e4" }],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
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
        commentary: null,
        latencyMs: 0,
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        usageReported: true,
        providerRequestId: "resp_integration1",
      },
    ]);
    expect(stored.moves).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(credential.apiKey);
    for (const [, init] of fetch.mock.calls.slice(1)) {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.temperature).toBe(0);
      expect(body.reasoning).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(credential.apiKey);
    }
    expect((await turn(api, guest, command, credential)).statusCode).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("pauses an AI-versus-human game on upstream quota failure without spending the invalid-output budget", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(openAiModels()))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "insufficient_quota", message: credential.apiKey } },
          { status: 429 },
        ),
      );
    const adapter = createOpenAiProvider({ fetch, now: () => 0 });
    const api = await harness.createApi({ ai: { providers: [{ adapter }] } });
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
    expect(JSON.stringify(stored)).not.toContain(credential.apiKey);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
