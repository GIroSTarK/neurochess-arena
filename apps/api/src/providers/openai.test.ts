import { createGame } from "@neurochess/chess";
import { type AiConfiguration, modelDiscoveryResultSchema } from "@neurochess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openAiModels, openAiResponse } from "../../test/openai-fixtures.js";
import { providerContractTests } from "../../test/provider-contract.js";

import { buildModelContext, MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { createOpenAiProvider } from "./openai.js";

const apiKey = "openai-key-canary";
const configuration: AiConfiguration = { provider: "openai", modelId: "gpt-4.1", parameters: {} };
const game = createGame();
game.start();
const context = buildModelContext(game, "white");
const request = { apiKey, configuration, context };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

providerContractTests({
  name: "OpenAI (mock HTTP)",
  provider: "openai",
  modelId: configuration.modelId,
  create(steps) {
    let attempts = 0;
    let clock = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === "GET") return Response.json(openAiModels());
      const step = steps[attempts++];
      if (!step) throw new Error("UNEXPECTED_PROVIDER_ATTEMPT");
      clock += step.telemetry?.latencyMs ?? 0;
      if ("error" in step) {
        const status = {
          provider_auth: 401,
          provider_quota: 429,
          provider_timeout: 504,
          provider_unavailable: 503,
        }[step.error.kind];
        return Response.json({ error: { message: apiKey } }, { status });
      }
      const usage = step.telemetry?.usage;
      return Response.json({
        ...openAiResponse(step.output),
        id: step.telemetry?.providerRequestId,
        usage: usage
          ? {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.totalTokens,
            }
          : null,
      });
    });
    return { adapter: createOpenAiProvider({ fetch, now: () => clock }), attempts: () => attempts };
  },
});

function fixture(response: unknown = openAiResponse()) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
  const adapter = createOpenAiProvider({ fetch, now: () => 0 });
  return { fetch, adapter };
}

describe("OpenAI discovery and requests", () => {
  it("uses request-only authentication and discovers exact live IDs without an allowlist", async () => {
    const ids = [
      "gpt-6-astra",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-4.1",
      "gpt-4.1-mini-2025-04-14",
      "gpt-4o-mini",
      "gpt-4o-mini-2024-07-18",
      "future-model",
      "text-embedding-3-small",
      "ft:gpt-4.1:org:custom:123",
      "gpt-6-astra-2099-01-01",
    ];
    const auth: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("error");
      auth.push(new Headers(init?.headers).get("Authorization"));
      return Response.json(openAiModels(ids));
    });
    vi.stubEnv("OPENAI_API_KEY", "unused-environment-canary");
    try {
      const adapter = createOpenAiProvider({ fetch });
      const result = await adapter.listModels({ apiKey });
      expect(modelDiscoveryResultSchema.parse(result)).toEqual(result);
      if (!result.ok) throw new Error("Unexpected discovery failure");
      expect(result.value.map((model) => model.id)).toEqual(ids);
      expect(result.value[0]?.supportedParameters).toEqual({
        reasoningEffort: { values: ["low", "medium", "high", "xhigh", "max"] },
        maxOutputTokens: { min: 16, max: 128_000 },
      });
      expect(result.value[1]?.supportedParameters.reasoningEffort?.values).toContain("none");
      expect(result.value[5]?.supportedParameters).toEqual({
        temperature: { min: 0, max: 2 },
        maxOutputTokens: { min: 16, max: 32_768 },
      });
      expect(result.value[7]?.supportedParameters.maxOutputTokens?.max).toBe(16_384);
      expect(
        result.value.slice(9).every((model) => Object.keys(model.supportedParameters).length === 0),
      ).toBe(true);
      result.value[0]!.supportedParameters.reasoningEffort!.values.splice(0);
      const refreshed = await adapter.listModels({ apiKey: "second-key-canary" });
      expect(
        refreshed.ok && refreshed.value[0]?.supportedParameters.reasoningEffort?.values.length,
      ).toBe(5);
      expect(auth).toEqual([`Bearer ${apiKey}`, "Bearer second-key-canary"]);
      expect(JSON.stringify(adapter)).not.toContain(apiKey);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {},
    { object: "list", data: null },
    openAiModels(["duplicate", "duplicate"]),
    openAiModels(["bad model"]),
    openAiModels([apiKey]),
    openAiModels(Array.from({ length: 2001 }, (_, i) => `model-${i}`)),
  ])("rejects malformed, duplicate, oversized, and credential-echoing catalogs", async (body) => {
    const { adapter } = fixture(body);
    await expect(adapter.listModels({ apiKey })).rejects.toThrow("INVALID_OPENAI_RESPONSE");
  });

  it("sends only canonical context, explicit supported parameters, and strict Responses output", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        model: "gpt-4.1",
        instructions: MODEL_RESPONSE_INSTRUCTION,
        input: [{ role: "user", content: JSON.stringify(context) }],
        store: false,
        stream: false,
        temperature: 0,
        max_output_tokens: 200,
        text: {
          format: {
            type: "json_schema",
            name: "chess_move",
            strict: true,
            schema: {
              type: "object",
              properties: {
                move: { type: "string", enum: context.legalMoves },
                commentary: { type: ["string", "null"], maxLength: 2000 },
              },
              required: ["move", "commentary"],
              additionalProperties: false,
            },
          },
        },
      });
      return Response.json(openAiResponse());
    });
    const adapter = createOpenAiProvider({ fetch });
    const input = {
      ...request,
      configuration: {
        ...configuration,
        parameters: { temperature: 0, maxOutputTokens: 200, reasoningEffort: "high" },
      },
    };
    const before = structuredClone(input);
    expect((await adapter.requestMove(input)).ok).toBe(true);
    expect(input).toEqual(before);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["gpt-6-astra", "gpt-5.6-terra", "future-model"])(
    "maps capabilities conservatively for %s",
    async (modelId) => {
      const { fetch, adapter } = fixture();
      await adapter.requestMove({
        ...request,
        configuration: {
          ...configuration,
          modelId,
          parameters: { temperature: 0, reasoningEffort: "high", maxOutputTokens: 1024 },
        },
      });
      const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
      expect(body.temperature).toBeUndefined();
      if (modelId === "future-model") {
        expect(body.reasoning).toBeUndefined();
        expect(body.max_output_tokens).toBeUndefined();
        expect(body.text).toBeUndefined();
      } else {
        expect(body.reasoning).toEqual({ effort: "high" });
        expect(body.max_output_tokens).toBe(1024);
      }
    },
  );

  it("rejects invalid input before provider I/O without exposing validation data", async () => {
    const { fetch, adapter } = fixture();
    for (const input of [
      { ...request, apiKey: "" },
      { ...request, apiKey: "key\r\ninjection" },
      { ...request, configuration: { ...configuration, provider: "google" } },
      { ...request, configuration: { ...configuration, apiKey } },
      { ...request, configuration: { ...configuration, parameters: { temperature: 2.1 } } },
      { ...request, configuration: { ...configuration, parameters: { maxOutputTokens: 15 } } },
      { ...request, configuration: { ...configuration, parameters: { maxOutputTokens: 32_769 } } },
      {
        ...request,
        configuration: {
          ...configuration,
          modelId: "gpt-6-astra",
          parameters: { reasoningEffort: "none" },
        },
      },
      { ...request, context: { ...context, sideToMove: "black" } },
      { ...request, context: { ...context, opponentModel: apiKey } },
    ]) {
      await expect(adapter.requestMove(input as typeof request)).rejects.toThrow(
        "INVALID_OPENAI_REQUEST",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("OpenAI output and telemetry", () => {
  it("accepts nullable commentary and ignores reasoning items when extracting message text", async () => {
    const response = openAiResponse({ move: "e2e4", commentary: null });
    const text = response.output[0]!.content[0]!.text;
    const { adapter } = fixture({
      ...response,
      output: [
        { type: "reasoning", summary: [{ text: apiKey }] },
        {
          ...response.output[0],
          content: [
            { type: "output_text", text: text.slice(0, 10) },
            { type: "output_text", text: text.slice(10) },
          ],
        },
      ],
    });
    expect(await adapter.requestMove(request)).toEqual({
      ok: true,
      value: { move: "e2e4", latencyMs: 0, usage: null },
    });
  });

  it.each([
    undefined,
    null,
    {},
    "unavailable",
    { input_tokens: -1, output_tokens: "2", total_tokens: 1.5 },
  ])("does not invent missing or malformed usage (%j)", async (usage) => {
    const { adapter } = fixture({ ...openAiResponse(), usage });
    const result = await adapter.requestMove(request);
    expect(result.ok && result.value.usage).toBeNull();
  });

  it.each([
    [{ input_tokens: 0 }, { inputTokens: 0, outputTokens: null, totalTokens: null }],
    [
      { input_tokens: 30, output_tokens: 12 },
      { inputTokens: 30, outputTokens: 12, totalTokens: null },
    ],
    [
      { output_tokens: 12, total_tokens: 42, input_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { inputTokens: null, outputTokens: 12, totalTokens: 42 },
    ],
  ])("retains partial reported counts, never inferred totals", async (usage, expected) => {
    const { adapter } = fixture({ ...openAiResponse(), usage: { ...usage, raw: { apiKey } } });
    const result = await adapter.requestMove(request);
    expect(result.ok && result.value.usage).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it.each([
    undefined,
    "https://example.test/token",
    "resp_bad\n",
    "request_123",
    "resp_" + "a".repeat(200),
  ])("omits unverified response IDs", async (id) => {
    const { adapter } = fixture({ ...openAiResponse(), id });
    const result = await adapter.requestMove(request);
    expect(result.ok && result.value.providerRequestId).toBeUndefined();
  });

  it.each([
    { ...openAiResponse(), id: `resp_${apiKey}` },
    openAiResponse({ move: "e2e4", commentary: apiKey }),
  ])("rejects credential echoes in permitted output fields", async (response) => {
    const { adapter } = fixture(response);
    await expect(adapter.requestMove(request)).rejects.toThrow("INVALID_OPENAI_RESPONSE");
  });

  it.each([
    { output: [] },
    { output: [{ type: "function_call", arguments: '{"move":"e2e4"}' }] },
    {
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: apiKey }],
        },
      ],
    },
    {
      output: [
        {
          type: "message",
          role: "user",
          status: "completed",
          content: [{ type: "output_text", text: '{"move":"e2e4"}' }],
        },
      ],
    },
    {
      output: [
        {
          type: "message",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "output_text", text: '{"move":"e2e4"}' }],
        },
      ],
    },
    { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    { status: "incomplete", incomplete_details: { reason: "content_filter" } },
  ])("rejects unusable or incomplete model output even if text looks legal", async (change) => {
    const { adapter } = fixture({
      ...openAiResponse(),
      ...change,
      usage: { input_tokens: 30, output_tokens: 2, total_tokens: 32 },
    });
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error: { kind: "model_invalid", reason: "malformed_output" },
      latencyMs: 0,
      usage: { inputTokens: 30, outputTokens: 2, totalTokens: 32 },
    });
  });
});

describe("OpenAI provider failures and cancellation", () => {
  it.each([
    [401, "provider_auth"],
    [403, "provider_auth"],
    [429, "provider_quota"],
    [408, "provider_timeout"],
    [504, "provider_timeout"],
    [400, "provider_unavailable"],
    [404, "provider_unavailable"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [302, "provider_unavailable"],
  ])("classifies HTTP %i for discovery and moves with no retries", async (status, kind) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(apiKey, { status: status }),
    );
    const adapter = createOpenAiProvider({ fetch, now: () => 0 });
    expect(await adapter.listModels({ apiKey })).toEqual({ ok: false, error: { kind } });
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error: { kind },
      latencyMs: 0,
      usage: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    {},
    { ...openAiResponse(), status: "unknown" },
    { ...openAiResponse(), status: "failed", error: { code: "server_error", message: apiKey } },
    { ...openAiResponse(), status: "queued" },
    { ...openAiResponse(), status: "cancelled" },
  ])(
    "treats malformed transport envelopes and unsuccessful responses as provider failures",
    async (response) => {
      const { adapter } = fixture(response);
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind: "provider_unavailable" },
        latencyMs: 0,
        usage: null,
      });
    },
  );

  it("normalizes failed-response error codes and preserves reported usage", async () => {
    const { adapter } = fixture({
      ...openAiResponse(),
      status: "failed",
      error: { code: "rate_limit_exceeded", message: apiKey },
      usage: { input_tokens: 10 },
      id: "resp_failed1",
    });
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error: { kind: "provider_quota" },
      latencyMs: 0,
      usage: { inputTokens: 10, outputTokens: null, totalTokens: null },
      providerRequestId: "resp_failed1",
    });
  });

  it.each(["network", "invalid-json", "timeout"])("contains raw %s failures", async (mode) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (mode === "invalid-json") return new Response(apiKey);
      if (mode === "timeout") throw new DOMException(apiKey, "TimeoutError");
      throw new Error(apiKey, { cause: { headers: { Authorization: apiKey } } });
    });
    const adapter = createOpenAiProvider({ fetch, now: () => 0 });
    const error = { kind: mode === "timeout" ? "provider_timeout" : "provider_unavailable" };
    expect(await adapter.listModels({ apiKey })).toEqual({ ok: false, error });
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error,
      latencyMs: 0,
      usage: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["discovery", "move"])("honors cancellation before %s I/O", async (operation) => {
    const { adapter, fetch } = fixture();
    const signal = AbortSignal.abort(new Error(apiKey));
    const result =
      operation === "move"
        ? await adapter.requestMove({ ...request, signal })
        : await adapter.listModels({ apiKey, signal });
    expect(result).toMatchObject({ ok: false, error: { kind: "provider_unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout"])(
    "cancels a pending response body on %s and clears timers",
    async (mode) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const body = new ReadableStream({
          start(stream) {
            init?.signal?.addEventListener("abort", () => stream.error(new Error(apiKey)), {
              once: true,
            });
            entered.resolve();
          },
        });
        return new Response(body);
      });
      const adapter = createOpenAiProvider({ fetch, timeoutMs: 1000, now: Date.now });
      const pending = adapter.requestMove({ ...request, signal: controller.signal });
      await entered.promise;
      if (mode === "abort") controller.abort(new Error(apiKey));
      else await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual({
        ok: false,
        error: { kind: mode === "timeout" ? "provider_timeout" : "provider_unavailable" },
        latencyMs: mode === "timeout" ? 1000 : 0,
        usage: null,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
