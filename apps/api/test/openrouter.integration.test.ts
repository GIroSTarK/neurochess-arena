import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_RESPONSE_INSTRUCTION } from "../src/providers/context.js";
import { createOpenAiProvider } from "../src/providers/openai.js";
import { createOpenRouterProvider } from "../src/providers/openrouter.js";

import { aiCommand, createAi, post, records, turn } from "./ai-helpers.js";
import { ApiHarness } from "./helpers.js";
import { openAiModels, openAiResponse } from "./openai-fixtures.js";
import {
  openRouterModelInfo,
  openRouterModels,
  openRouterResponse,
} from "./openrouter-fixtures.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());
const credential = { provider: "openrouter" as const, apiKey: "openrouter-http-key-canary" };
const configuration = {
  provider: "openrouter" as const,
  modelId: openRouterModelInfo().id,
  parameters: { temperature: 0, maxOutputTokens: 2048, reasoningEffort: "high" },
};

describe("OpenRouter through the authorized game service (mock HTTP)", () => {
  it("plays a mixed-provider game with private canonical context, retries, persistence, and deduplication", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${credential.apiKey}`);
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.endsWith("/models")
            ? openRouterModels()
            : { data: openRouterModelInfo() },
        );
      }
      attempts++;
      const body = JSON.parse(init?.body as string) as {
        model: string;
        messages: { content: string }[];
        temperature: number;
        max_tokens: number;
        reasoning: { effort: string };
      };
      const prompt = body.messages[0]!.content;
      expect(prompt.startsWith(`${MODEL_RESPONSE_INSTRUCTION}\n\n`)).toBe(true);
      const context = JSON.parse(prompt.slice(MODEL_RESPONSE_INSTRUCTION.length + 2)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(context).sort()).toEqual([
        "color",
        "fen",
        "legalMoves",
        "pgn",
        "sideToMove",
      ]);
      expect(context.sideToMove).toBe("black");
      expect(context.color).toBe("black");
      expect(context.pgn).toContain("e4");
      expect(context.legalMoves).toContain("e7e5");
      for (const secret of [
        "Private opponent commentary.",
        "openai",
        "gpt-4.1",
        credential.apiKey,
      ]) {
        expect(JSON.stringify(body)).not.toContain(secret);
      }
      expect(body.model).toBe(configuration.modelId);
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(2048);
      expect(body.reasoning).toEqual({ effort: "high" });
      if (attempts === 1) return Response.json(openRouterResponse({ move: "e7e4" }));
      return Response.json({
        ...openRouterResponse({ move: "e7e5", commentary: "Black takes the center." }),
        usage: { prompt_tokens: 30, completion_tokens: 12, metadata: credential },
        id: "gen-integration1",
        provider: "upstream-provider",
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
          { adapter: createOpenRouterProvider({ fetch, now: () => 0 }) },
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
      stored.invocations.filter((invocation) => invocation.provider === "openrouter"),
    ).toMatchObject([
      { status: "model_invalid", attempt: 1, invalidReason: "illegal_move", usageReported: false },
      {
        status: "succeeded",
        attempt: 2,
        modelId: configuration.modelId,
        move: "e7e5",
        commentary: "Black takes the center.",
        latencyMs: 0,
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: null,
        usageReported: true,
        providerRequestId: "gen-integration1",
      },
    ]);
    expect(stored.moves).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain(credential.apiKey);
    expect((await turn(api, guest, command, credential)).statusCode).toBe(409);
    expect(attempts).toBe(2);
    expect(openAiFetch).toHaveBeenCalledTimes(2);
  });

  it("supports incomplete metadata and pauses on an HTTP-200 error until explicit retry with a new key", async () => {
    let attempts = 0;
    const keys: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "GET") {
        const model = { id: configuration.modelId, top_provider: null, supported_parameters: null };
        return Response.json({
          data: typeof url === "string" && url.endsWith("/models") ? [model] : model,
        });
      }
      keys.push(new Headers(init?.headers).get("Authorization"));
      attempts++;
      expect(JSON.parse(init?.body as string)).not.toHaveProperty("temperature");
      if (attempts === 1) {
        return Response.json({ error: { code: 402, message: credential.apiKey } });
      }
      return Response.json(openRouterResponse());
    });
    const api = await harness.createApi({
      ai: { providers: [{ adapter: createOpenRouterProvider({ fetch, now: () => 0 }) }] },
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
        temperature: null,
        reasoningEffort: null,
        maxOutputTokens: null,
      },
    ]);
    expect(stored.invocations).toHaveLength(1);
    expect(attempts).toBe(1);
    const replacement = { ...credential, apiKey: "replacement-openrouter-key-canary" };
    const retry = await turn(api, guest, aiCommand(response.json()), replacement);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ state: "paused", moves: [{ uci: "e2e4" }] });
    expect(keys).toEqual([`Bearer ${credential.apiKey}`, `Bearer ${replacement.apiKey}`]);
    const retried = await records(api, initial.gameId);
    expect(retried.invocations[1]).toMatchObject({
      status: "succeeded",
      usageReported: false,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(JSON.stringify(retried)).not.toContain("key-canary");
  });

  it("records technical loss only after three unusable completions", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.endsWith("/models")
            ? openRouterModels()
            : { data: openRouterModelInfo() },
        );
      }
      attempts++;
      return Response.json({ choices: [] });
    });
    const api = await harness.createApi({
      ai: { providers: [{ adapter: createOpenRouterProvider({ fetch, now: () => 0 }) }] },
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
