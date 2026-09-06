import { createGame } from "@neurochess/chess";
import { type AiConfiguration, modelDiscoveryResultSchema } from "@neurochess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openRouterModelInfo, openRouterResponse } from "../../test/openrouter-fixtures.js";
import { contractTelemetry, providerContractTests } from "../../test/provider-contract.js";

import { buildModelContext, MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { createOpenRouterProvider } from "./openrouter.js";

const apiKey = "openrouter-key-canary";
const configuration: AiConfiguration = {
  provider: "openrouter",
  modelId: openRouterModelInfo().id,
  parameters: {},
};
const game = createGame();
game.start();
const context = buildModelContext(game, "white");
const request = { apiKey, configuration, context };
const telemetry = { ...contractTelemetry, providerRequestId: "gen-contract1" };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

for (const info of [openRouterModelInfo(), { id: "future/unknown:variant" }]) {
  providerContractTests({
    name: `OpenRouter ${info.id} (mock HTTP)`,
    provider: "openrouter",
    modelId: info.id,
    telemetry,
    create(steps) {
      let attempts = 0;
      let clock = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (init?.method === "GET") {
          return Response.json({
            data: typeof url === "string" && url.endsWith("/models") ? [info] : info,
          });
        }
        const step = steps[attempts++];
        if (!step) throw new Error("UNEXPECTED_PROVIDER_ATTEMPT");
        clock += step.telemetry?.latencyMs ?? 0;
        if ("error" in step) {
          const status = {
            provider_auth: 401,
            provider_quota: 402,
            provider_timeout: 408,
            provider_unavailable: 502,
          }[step.error.kind];
          return Response.json({ error: { code: status, message: apiKey } }, { status });
        }
        const usage = step.telemetry?.usage;
        return Response.json({
          ...openRouterResponse(step.output),
          ...(usage
            ? {
                usage: {
                  prompt_tokens: usage.inputTokens,
                  completion_tokens: usage.outputTokens,
                  total_tokens: usage.totalTokens,
                },
              }
            : {}),
          ...(step.telemetry?.providerRequestId ? { id: step.telemetry.providerRequestId } : {}),
        });
      });
      return {
        adapter: createOpenRouterProvider({ fetch, now: () => clock }),
        attempts: () => attempts,
      };
    },
  });
}

function fixture(response: unknown = openRouterResponse(), model: unknown = openRouterModelInfo()) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    Response.json(init?.method === "GET" ? { data: model } : response),
  );
  return { fetch, adapter: createOpenRouterProvider({ fetch, now: () => 0 }) };
}

describe("OpenRouter live discovery", () => {
  it("preserves identifiers and refreshes with the current key without startup calls or retained credentials", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "unused-environment-key");
    const captured: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/models");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init?.body).toBeUndefined();
      captured.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({
        data: [openRouterModelInfo(), { id: `new/model-${captured.length}:free` }],
      });
    });
    const adapter = createOpenRouterProvider({ fetch });
    expect(fetch).not.toHaveBeenCalled();
    for (const key of [apiKey, "replacement-key"]) {
      const result = await adapter.listModels({ apiKey: key });
      expect(modelDiscoveryResultSchema.parse(result)).toEqual(result);
      expect(result.ok && result.value.map((model) => model.id)).toEqual([
        configuration.modelId,
        `new/model-${captured.length}:free`,
      ]);
      expect(JSON.stringify(result)).not.toContain(key);
      expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBeNull();
    }
    expect(captured).toEqual([`Bearer ${apiKey}`, "Bearer replacement-key"]);
  });

  it("maps individual capabilities, ignores pricing, and filters only known incompatible modalities", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        data: [
          {
            ...openRouterModelInfo(),
            per_request_limits: { completion_tokens: 4096 },
            pricing: { prompt: apiKey },
          },
          {
            id: "new/incomplete",
            supported_parameters: ["max_tokens", "reasoning"],
            context_length: 100000,
            reasoning: { mandatory: true },
          },
          {
            id: "new/nulls",
            name: null,
            supported_parameters: null,
            top_provider: null,
            reasoning: null,
            architecture: null,
          },
          {
            id: "new/audio",
            architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
          },
          {
            id: "new/transcribe",
            architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
          },
        ],
      }),
    );
    expect(await createOpenRouterProvider({ fetch }).listModels({ apiKey })).toEqual({
      ok: true,
      value: [
        {
          provider: "openrouter",
          id: configuration.modelId,
          name: "Example chess model",
          supportedParameters: {
            temperature: { min: 0, max: 2 },
            maxOutputTokens: { min: 16, max: 4096 },
            reasoningEffort: { values: ["high", "medium", "low"] },
          },
        },
        {
          provider: "openrouter",
          id: "new/incomplete",
          name: "new/incomplete",
          supportedParameters: {},
        },
        { provider: "openrouter", id: "new/nulls", name: "new/nulls", supportedParameters: {} },
      ],
    });
  });

  it.each([
    [
      { supported_efforts: null, mandatory: true },
      ["max", "xhigh", "high", "medium", "low", "minimal"],
    ],
    [{ supported_efforts: ["none", "low", "low", null], mandatory: true }, ["low"]],
    [{ supported_efforts: ["none", "low"], mandatory: false }, ["none", "low"]],
    [{ supported_efforts: [], mandatory: false }, undefined],
    [{ supports_max_tokens: true, mandatory: false }, undefined],
  ])("uses live reasoning options %j", async (reasoning, values) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: [{ id: configuration.modelId, reasoning }] }),
    );
    const result = await createOpenRouterProvider({ fetch }).listModels({ apiKey });
    expect(result.ok && result.value[0]?.supportedParameters.reasoningEffort).toEqual(
      values ? { values } : undefined,
    );
  });

  it.each([undefined, null, -1, 0, 1.5, "8192", Number.MAX_SAFE_INTEGER + 1])(
    "does not invent missing or malformed output limits %j",
    async (limit) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          data: [{ ...openRouterModelInfo(), top_provider: { max_completion_tokens: limit } }],
        }),
      );
      const result = await createOpenRouterProvider({ fetch }).listModels({ apiKey });
      expect(result.ok && result.value[0]?.supportedParameters.maxOutputTokens).toBeUndefined();
    },
  );

  it.each([
    {},
    { data: [{}] },
    { data: [{ id: "invalid" }] },
    { data: [openRouterModelInfo(), openRouterModelInfo()] },
    { data: Array.from({ length: 2001 }, (_, i) => ({ id: `new/model-${i}` })) },
    { data: [{ id: `new/${apiKey}` }] },
    { data: [{ id: configuration.modelId, name: apiKey }] },
    { data: [{ id: configuration.modelId, reasoning: { supported_efforts: [apiKey] } }] },
  ])(
    "rejects malformed, oversized, duplicate, or secret-bearing catalogs safely",
    async (response) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
      await expect(createOpenRouterProvider({ fetch }).listModels({ apiKey })).rejects.toThrow(
        "INVALID_OPENROUTER_RESPONSE",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("OpenRouter move requests", () => {
  it("refreshes alias metadata, preserves the selected variant, and sends only supported parameters and canonical context", async () => {
    const { adapter, fetch } = fixture(openRouterResponse(), {
      ...openRouterModelInfo("resolved/actual-model"),
      per_request_limits: { completion_tokens: 4096 },
    });
    expect(
      (
        await adapter.requestMove({
          ...request,
          configuration: {
            ...configuration,
            parameters: { temperature: 0, maxOutputTokens: 2048, reasoningEffort: "low" },
          },
        })
      ).ok,
    ).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://openrouter.ai/api/v1/model/example/chess-model%3Afree",
    );
    const call = fetch.mock.calls[1];
    expect(call?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      model: configuration.modelId,
      messages: [
        { role: "user", content: `${MODEL_RESPONSE_INSTRUCTION}\n\n${JSON.stringify(context)}` },
      ],
      stream: false,
      provider: { require_parameters: true, allow_fallbacks: false },
      temperature: 0,
      max_tokens: 2048,
      reasoning: { effort: "low" },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "chess_move",
          strict: true,
          schema: {
            type: "object",
            properties: {
              move: { type: "string", enum: context.legalMoves },
              commentary: { type: ["string", "null"] },
            },
            required: ["move", "commentary"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(call?.[1]?.body).not.toContain(apiKey);
  });

  it.each([
    [[], undefined],
    [["response_format"], { type: "json_object" }],
  ])(
    "uses available output support %j and drops unknown parameters",
    async (supported_parameters, format) => {
      const { adapter, fetch } = fixture(openRouterResponse(), {
        id: configuration.modelId,
        supported_parameters,
      });
      await adapter.requestMove({
        ...request,
        configuration: {
          ...configuration,
          parameters: { temperature: 0, maxOutputTokens: 2048, reasoningEffort: "high" },
        },
      });
      const body = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string) as Record<string, unknown>;
      expect(body.response_format).toEqual(format);
      for (const key of ["temperature", "max_tokens", "max_completion_tokens", "reasoning"]) {
        expect(body[key]).toBeUndefined();
      }
    },
  );

  it("prefers max_completion_tokens when the model advertises it", async () => {
    const { adapter, fetch } = fixture(openRouterResponse(), {
      ...openRouterModelInfo(),
      supported_parameters: ["max_tokens", "max_completion_tokens"],
    });
    await adapter.requestMove({
      ...request,
      configuration: { ...configuration, parameters: { maxOutputTokens: 2048 } },
    });
    const body = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it.each([
    { temperature: 2.1 },
    { maxOutputTokens: 15 },
    { maxOutputTokens: 8193 },
    { reasoningEffort: "none" },
  ])("rejects invalid supported parameters before generation %j", async (parameters) => {
    const { adapter, fetch } = fixture();
    await expect(
      adapter.requestMove({ ...request, configuration: { ...configuration, parameters } }),
    ).rejects.toThrow("INVALID_OPENROUTER_REQUEST");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["../model", "org/..", "org/.", "org/", "org/a/b", `org/${apiKey}`])(
    "rejects unsafe metadata paths %s before I/O",
    async (modelId) => {
      const { adapter, fetch } = fixture();
      await expect(
        adapter.requestMove({ ...request, configuration: { ...configuration, modelId } }),
      ).rejects.toThrow("INVALID_OPENROUTER_REQUEST");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("normalizes text parts and null commentary without exposing reasoning or routing metadata", async () => {
    const response = {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: '{"move":' },
              { type: "text", text: '"e2e4","commentary":null}' },
            ],
            reasoning: apiKey,
            reasoning_details: [{ text: apiKey }],
            refusal: null,
            tool_calls: [],
          },
        },
      ],
      provider: apiKey,
      openrouter_metadata: { apiKey },
    };
    expect(await fixture(response).adapter.requestMove(request)).toEqual({
      ok: true,
      value: { move: "e2e4", latencyMs: 0, usage: null },
    });
  });

  it.each([
    { finish_reason: "length" },
    { finish_reason: "content_filter" },
    { finish_reason: "tool_calls" },
    { finish_reason: null },
    { message: { role: "assistant", content: '{"move":"e2e4"}', refusal: "Refused" } },
    { message: { role: "assistant", content: '{"move":"e2e4"}', tool_calls: [{}] } },
    { message: { role: "assistant", content: [{ type: "image_url", text: '{"move":"e2e4"}' }] } },
    { message: { role: "assistant", content: null, reasoning: '{"move":"e2e4"}' } },
    { message: { role: "assistant", content: '{"move":"e2e4"}', audio: {} } },
    { message: { role: "assistant", content: '{"move":"e2e4"}', images: [{}] } },
  ])("treats unusable completion output as model-invalid (%j)", async (overrides) => {
    const response = openRouterResponse();
    const { adapter } = fixture({ choices: [{ ...response.choices[0], ...overrides }] });
    expect(await adapter.requestMove(request)).toMatchObject({
      ok: false,
      error: { kind: "model_invalid", reason: "malformed_output" },
    });
  });

  it.each([
    { choices: [] },
    { choices: [openRouterResponse().choices[0], openRouterResponse().choices[0]] },
  ])("rejects missing or ambiguous choices", async ({ choices }) => {
    expect(await fixture({ choices }).adapter.requestMove(request)).toMatchObject({
      ok: false,
      error: { kind: "model_invalid" },
    });
  });

  it.each([undefined, null, {}, { prompt_tokens: -1, completion_tokens: "2", total_tokens: 1.5 }])(
    "keeps unavailable usage null (%j)",
    async (usage) => {
      expect(
        await fixture({ ...openRouterResponse(), usage }).adapter.requestMove(request),
      ).toMatchObject({ ok: true, value: { usage: null } });
    },
  );

  it.each([
    [{ prompt_tokens: 0 }, { inputTokens: 0, outputTokens: null, totalTokens: null }],
    [
      { prompt_tokens: 20, completion_tokens: 8 },
      { inputTokens: 20, outputTokens: 8, totalTokens: null },
    ],
    [
      { prompt_tokens: 20, completion_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: 50 },
      { inputTokens: 20, outputTokens: null, totalTokens: 50 },
    ],
    [
      {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 8 },
        cost: 2,
        metadata: apiKey,
      },
      { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    ],
  ])(
    "preserves partial counts without guessing or double counting (%j)",
    async (usage, expected) => {
      expect(
        await fixture({ ...openRouterResponse(), usage }).adapter.requestMove(request),
      ).toEqual({ ok: true, value: { move: "e2e4", latencyMs: 0, usage: expected } });
    },
  );

  it.each([
    "gen-safe1",
    "chatcmpl-safe1",
    "https://example.com/key",
    "gen-unsafe\n",
    `gen-${apiKey}`,
  ])("retains only safe response identifiers %s", async (id) => {
    const { adapter } = fixture({ ...openRouterResponse(), id });
    if (id.includes(apiKey)) {
      await expect(adapter.requestMove(request)).rejects.toThrow("INVALID_OPENROUTER_RESPONSE");
    } else {
      const result = await adapter.requestMove(request);
      expect(result.ok && result.value.providerRequestId).toBe(
        id.endsWith("safe1") ? id : undefined,
      );
    }
  });

  it("rejects credential echoes in commentary", async () => {
    await expect(
      fixture(openRouterResponse({ move: "e2e4", commentary: apiKey })).adapter.requestMove(
        request,
      ),
    ).rejects.toThrow("INVALID_OPENROUTER_RESPONSE");
  });
});

describe("OpenRouter operational errors and cancellation", () => {
  it.each([
    [401, "provider_auth"],
    [403, "provider_auth"],
    [402, "provider_quota"],
    [429, "provider_quota"],
    [408, "provider_timeout"],
    [504, "provider_timeout"],
    [400, "provider_unavailable"],
    [502, "provider_unavailable"],
    [503, "provider_unavailable"],
    [529, "provider_unavailable"],
  ])("classifies HTTP and embedded error %s without retrying", async (code, kind) => {
    for (const status of [code, 200]) {
      const response = { error: { code, message: apiKey, metadata: { raw: apiKey } } };
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response, { status }));
      const adapter = createOpenRouterProvider({ fetch, now: () => 0 });
      expect(await adapter.listModels({ apiKey })).toEqual({ ok: false, error: { kind } });
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind },
        latencyMs: 0,
        usage: null,
      });
      fetch.mockResolvedValueOnce(Response.json({ data: openRouterModelInfo() }));
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind },
        latencyMs: 0,
        usage: null,
      });
      expect(fetch).toHaveBeenCalledTimes(4);
    }
  });

  it.each([
    ["authentication", "provider_auth"],
    ["permission_denied", "provider_auth"],
    ["payment_required", "provider_quota"],
    ["rate_limit_exceeded", "provider_quota"],
    ["token_limit_exceeded", "provider_quota"],
    ["timeout", "provider_timeout"],
    ["provider_overloaded", "provider_unavailable"],
    ["refusal", "provider_unavailable"],
    ["unmapped", "provider_unavailable"],
  ])(
    "classifies typed upstream error %s and preserves safe partial telemetry",
    async (error_type, kind) => {
      const response = {
        ...openRouterResponse(),
        id: "gen-failure1",
        usage: { prompt_tokens: 30 },
        error: { code: 500, metadata: { error_type, provider_code: apiKey } },
      };
      expect(await fixture(response).adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind },
        latencyMs: 0,
        usage: { inputTokens: 30, outputTokens: null, totalTokens: null },
        providerRequestId: "gen-failure1",
      });
    },
  );

  it.each([{ finish_reason: "error" }, { finish_reason: "stop", error: { code: 429 } }])(
    "never accepts an error choice as a legal move",
    async (overrides) => {
      const response = { choices: [{ ...openRouterResponse().choices[0], ...overrides }] };
      expect(await fixture(response).adapter.requestMove(request)).toMatchObject({
        ok: false,
        error: { kind: "error" in overrides ? "provider_quota" : "provider_unavailable" },
      });
    },
  );

  it.each([{}, null, { choices: "invalid" }])(
    "treats malformed envelopes as operational failure",
    async (response) => {
      expect(await fixture(response).adapter.requestMove(request)).toMatchObject({
        ok: false,
        error: { kind: "provider_unavailable" },
      });
    },
  );

  it.each(["network", "timeout", "json"])("sanitizes %s transport failures", async (mode) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (mode === "json") return new Response("invalid-json");
      if (mode === "timeout") throw new DOMException(apiKey, "TimeoutError");
      throw new Error(apiKey, { cause: { authorization: apiKey } });
    });
    const adapter = createOpenRouterProvider({ fetch, now: () => 0 });
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error: { kind: mode === "timeout" ? "provider_timeout" : "provider_unavailable" },
      latencyMs: 0,
      usage: null,
    });
  });

  it("cancels before I/O", async () => {
    const { adapter, fetch } = fixture();
    const signal = AbortSignal.abort(new Error(apiKey));
    expect(await adapter.listModels({ apiKey, signal })).toEqual({
      ok: false,
      error: { kind: "provider_unavailable" },
    });
    expect(await adapter.requestMove({ ...request, signal })).toMatchObject({
      ok: false,
      error: { kind: "provider_unavailable" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies a body-read timeout and counts metadata and body latency", async () => {
    let clock = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      clock += 10;
      if (init?.method === "GET") return Response.json({ data: openRouterModelInfo() });
      return new Response(
        new ReadableStream({
          pull(stream) {
            clock += 20;
            stream.error(new DOMException(apiKey, "TimeoutError"));
          },
        }),
      );
    });
    expect(
      await createOpenRouterProvider({ fetch, now: () => clock }).requestMove(request),
    ).toEqual({
      ok: false,
      error: { kind: "provider_timeout" },
      latencyMs: 40,
      usage: null,
    });
  });

  it.each(["abort", "timeout"])(
    "cancels discovery, metadata, generation, and error bodies on %s",
    async (mode) => {
      vi.useFakeTimers();
      for (const stage of ["discovery", "metadata", "generation", "error"]) {
        const controller = new AbortController();
        const entered = Promise.withResolvers<void>();
        const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
          if (["generation", "error"].includes(stage) && init?.method === "GET") {
            return Response.json({ data: openRouterModelInfo() });
          }
          return new Response(
            new ReadableStream({
              start(stream) {
                init?.signal?.addEventListener("abort", () => stream.error(new Error(apiKey)), {
                  once: true,
                });
                entered.resolve();
              },
            }),
            { status: stage === "error" ? 429 : 200 },
          );
        });
        const adapter = createOpenRouterProvider({ fetch, timeoutMs: 1000, now: Date.now });
        const pending =
          stage === "discovery"
            ? adapter.listModels({ apiKey, signal: controller.signal })
            : adapter.requestMove({ ...request, signal: controller.signal });
        await entered.promise;
        if (mode === "abort") controller.abort(new Error(apiKey));
        else await vi.advanceTimersByTimeAsync(1000);
        expect(await pending).toEqual({
          ok: false,
          error: { kind: mode === "timeout" ? "provider_timeout" : "provider_unavailable" },
          ...(stage === "discovery"
            ? {}
            : { latencyMs: mode === "timeout" ? 1000 : 0, usage: null }),
        });
        expect(fetch).toHaveBeenCalledTimes(["generation", "error"].includes(stage) ? 2 : 1);
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );
});
