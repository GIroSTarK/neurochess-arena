import { createGame } from "@neurochess/chess";
import { type AiConfiguration, modelDiscoveryResultSchema } from "@neurochess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  anthropicMessage,
  anthropicModelInfo,
  anthropicModels,
} from "../../test/anthropic-fixtures.js";
import { providerContractTests } from "../../test/provider-contract.js";

import { createAnthropicProvider } from "./anthropic.js";
import { buildModelContext, MODEL_RESPONSE_INSTRUCTION } from "./context.js";

const apiKey = "anthropic-key-canary";
const configuration: AiConfiguration = {
  provider: "anthropic",
  modelId: anthropicModelInfo().id,
  parameters: {},
};
const game = createGame();
game.start();
const context = buildModelContext(game, "white");
const request = { apiKey, configuration, context };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

providerContractTests({
  name: "Anthropic (mock HTTP)",
  provider: "anthropic",
  modelId: configuration.modelId,
  telemetry: {
    latencyMs: 125.5,
    usage: { inputTokens: 30, outputTokens: 12, totalTokens: null },
    providerRequestId: "req_contract1",
  },
  create(steps) {
    let attempts = 0;
    let clock = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.includes("models?")
            ? anthropicModels()
            : anthropicModelInfo(),
        );
      }
      const step = steps[attempts++];
      if (!step) throw new Error("UNEXPECTED_PROVIDER_ATTEMPT");
      clock += step.telemetry?.latencyMs ?? 0;
      if ("error" in step) {
        const status = {
          provider_auth: 401,
          provider_quota: 429,
          provider_timeout: 504,
          provider_unavailable: 529,
        }[step.error.kind];
        return Response.json({ type: "error", error: { message: apiKey } }, { status });
      }
      const usage = step.telemetry?.usage;
      return Response.json(
        {
          ...anthropicMessage(step.output),
          usage: usage
            ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
            : null,
        },
        {
          headers: step.telemetry?.providerRequestId
            ? { "request-id": step.telemetry.providerRequestId }
            : {},
        },
      );
    });
    return {
      adapter: createAnthropicProvider({ fetch, now: () => clock }),
      attempts: () => attempts,
    };
  },
});

function fixture(response: unknown = anthropicMessage(), model: unknown = anthropicModelInfo()) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    Response.json(init?.method === "GET" ? model : response),
  );
  return { fetch, adapter: createAnthropicProvider({ fetch, now: () => 0 }) };
}

describe("Anthropic discovery and capabilities", () => {
  it("discovers live IDs across pages with request-only auth and current capability metadata", async () => {
    const modern = anthropicModelInfo("newly-discovered-model");
    modern.display_name = "Newly discovered model";
    modern.capabilities.effort.supported = true;
    modern.capabilities.effort.low.supported = true;
    modern.capabilities.effort.high.supported = true;
    modern.capabilities.effort.max.supported = true;
    const first = { ...anthropicModels(), has_more: true };
    const second = { ...anthropicModels([modern.id]), data: [modern] };
    const auth: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("authorization")).toBeNull();
      auth.push(headers.get("x-api-key"));
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("error");
      expect(url).not.toContain(apiKey);
      return Response.json(typeof url === "string" && url.includes("after_id=") ? second : first);
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "unused-environment-canary");
    const adapter = createAnthropicProvider({ fetch });
    expect(fetch).not.toHaveBeenCalled();
    const result = await adapter.listModels({ apiKey });
    expect(modelDiscoveryResultSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          provider: "anthropic",
          id: configuration.modelId,
          name: "Claude Haiku 4.5",
          supportedParameters: {
            temperature: { min: 0, max: 1 },
            maxOutputTokens: { min: 1, max: 64_000 },
          },
        },
        {
          provider: "anthropic",
          id: modern.id,
          name: modern.display_name,
          supportedParameters: {
            maxOutputTokens: { min: 1, max: 64_000 },
            reasoningEffort: { values: ["low", "high", "max"] },
          },
        },
      ],
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      `https://api.anthropic.com/v1/models?limit=1000&after_id=${configuration.modelId}`,
    ]);
    if (result.ok) result.value.splice(0);
    expect(await adapter.listModels({ apiKey: "second-key-canary" })).toMatchObject({ ok: true });
    expect(auth).toEqual([apiKey, apiKey, "second-key-canary", "second-key-canary"]);
    expect(JSON.stringify(adapter)).not.toContain(apiKey);
    expect(fetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has("x-api-key"))).toBe(
      true,
    );
  });

  it("retains unknown models without inventing capabilities and accepts an empty catalog", async () => {
    const unknown = anthropicModelInfo("unknown-snapshot-20990101");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...anthropicModels([unknown.id]),
          data: [{ ...unknown, capabilities: null, max_tokens: null }],
        }),
      )
      .mockResolvedValueOnce(Response.json(anthropicModels([])));
    const adapter = createAnthropicProvider({ fetch });
    expect(await adapter.listModels({ apiKey })).toMatchObject({
      ok: true,
      value: [{ id: unknown.id, supportedParameters: {} }],
    });
    expect(await adapter.listModels({ apiKey })).toEqual({ ok: true, value: [] });
  });

  it.each([
    {},
    { ...anthropicModels(), data: null },
    anthropicModels(["duplicate", "duplicate"]),
    anthropicModels(["bad model"]),
    anthropicModels([apiKey]),
    { ...anthropicModels(), data: [{ ...anthropicModelInfo(), display_name: apiKey }] },
    { ...anthropicModels(), data: [{ ...anthropicModelInfo(), max_tokens: -1 }] },
    {
      ...anthropicModels(),
      data: [{ ...anthropicModelInfo(), capabilities: { effort: { supported: "yes" } } }],
    },
    { ...anthropicModels(), last_id: "wrong-cursor" },
    { ...anthropicModels([]), has_more: true },
    anthropicModels(Array.from({ length: 1001 }, (_, i) => `model-${i}`)),
  ])("rejects malformed, duplicate, oversized, or secret-bearing pages", async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
    await expect(createAnthropicProvider({ fetch }).listModels({ apiKey })).rejects.toThrow(
      "INVALID_ANTHROPIC_RESPONSE",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects pagination loops and catalogs larger than the shared limit", async () => {
    for (const mode of ["loop", "oversize", "too-many-pages"]) {
      let page = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        const ids = Array.from(
          { length: mode === "oversize" ? 1000 : 1 },
          (_, i) => `${mode}-${mode === "loop" ? 0 : page}-${i}`,
        );
        page++;
        return Response.json({ ...anthropicModels(ids), has_more: true });
      });
      await expect(createAnthropicProvider({ fetch }).listModels({ apiKey })).rejects.toThrow(
        "INVALID_ANTHROPIC_RESPONSE",
      );
      expect(fetch).toHaveBeenCalledTimes(mode === "too-many-pages" ? 20 : 2);
    }
  });

  it("discards partial discovery when a later page fails", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...anthropicModels(), has_more: true }))
      .mockResolvedValueOnce(Response.json({ error: { message: apiKey } }, { status: 429 }));
    expect(await createAnthropicProvider({ fetch }).listModels({ apiKey })).toEqual({
      ok: false,
      error: { kind: "provider_quota" },
    });
  });
});

describe("Anthropic move requests", () => {
  it("uses only canonical context and supported parameters with the Messages JSON schema dialect", async () => {
    const { fetch, adapter } = fixture();
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
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://api.anthropic.com/v1/models/${configuration.modelId}`,
    );
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({
      model: configuration.modelId,
      system: MODEL_RESPONSE_INSTRUCTION,
      messages: [{ role: "user", content: JSON.stringify(context) }],
      max_tokens: 200,
      temperature: 0,
      stream: false,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              move: { type: "string", enum: context.legalMoves },
              commentary: { type: "string" },
            },
            required: ["move"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps reported effort levels and drops temperature for modern models without a warm catalog", async () => {
    const modern = anthropicModelInfo("claude-opus-5");
    modern.capabilities.effort.supported = true;
    modern.capabilities.effort.xhigh.supported = true;
    const { fetch, adapter } = fixture(anthropicMessage(), modern);
    const result = await adapter.requestMove({
      ...request,
      configuration: {
        ...configuration,
        modelId: modern.id,
        parameters: { temperature: 0, reasoningEffort: "xhigh", maxOutputTokens: 1000 },
      },
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toMatchObject({ effort: "xhigh" });
    expect(body.max_tokens).toBe(1000);
  });

  it.each([null, 100, 64_000])(
    "supplies the required default token budget bounded by reported limits (%j)",
    async (max_tokens) => {
      const { fetch, adapter } = fixture(anthropicMessage(), {
        ...anthropicModelInfo("unknown"),
        capabilities: null,
        max_tokens,
      });
      await adapter.requestMove({
        ...request,
        configuration: {
          ...configuration,
          modelId: "unknown",
          parameters: { temperature: 0, reasoningEffort: "high" },
        },
      });
      const body = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string) as Record<string, unknown>;
      expect(body.max_tokens).toBe(Math.min(4096, max_tokens ?? 4096));
      expect(body.temperature).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    },
  );

  it("resolves aliases and encodes model path segments", async () => {
    const { fetch, adapter } = fixture();
    for (const modelId of ["claude-haiku-4-5", "custom/model?x=1#fragment"]) {
      await adapter.requestMove({ ...request, configuration: { ...configuration, modelId } });
      expect(fetch.mock.lastCall?.[1]?.body).toContain(modelId);
    }
    expect(fetch.mock.calls[2]?.[0]).toBe(
      "https://api.anthropic.com/v1/models/custom%2Fmodel%3Fx%3D1%23fragment",
    );
  });

  it("rejects invalid boundary inputs before any provider I/O", async () => {
    const { adapter, fetch } = fixture();
    for (const input of [
      { ...request, apiKey: "" },
      { ...request, apiKey: "key\r\ninjection" },
      { ...request, configuration: { ...configuration, provider: "google" } },
      { ...request, configuration: { ...configuration, modelId: ".." } },
      { ...request, configuration: { ...configuration, modelId: apiKey } },
      { ...request, configuration: { ...configuration, apiKey } },
      { ...request, configuration: { ...configuration, parameters: { maxOutputTokens: 0 } } },
      { ...request, context: { ...context, sideToMove: "black" } },
      { ...request, context: { ...context, opponentModel: apiKey } },
    ]) {
      await expect(adapter.requestMove(input as typeof request)).rejects.toThrow(
        "INVALID_ANTHROPIC_REQUEST",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ temperature: 1.1 }, { maxOutputTokens: 64_001 }, { reasoningEffort: "unverified" }])(
    "rejects out-of-range supported parameters before a paid move request (%j)",
    async (parameters) => {
      const model = anthropicModelInfo();
      model.capabilities.effort.supported = true;
      model.capabilities.effort.high.supported = true;
      const { adapter, fetch } = fixture(anthropicMessage(), model);
      await expect(
        adapter.requestMove({ ...request, configuration: { ...configuration, parameters } }),
      ).rejects.toThrow("INVALID_ANTHROPIC_REQUEST");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Anthropic response blocks and telemetry", () => {
  it("joins only text and never exposes thinking or redacted thinking", async () => {
    const text = JSON.stringify({ move: "e2e4", commentary: "Center." });
    const { adapter } = fixture({
      ...anthropicMessage(),
      content: [
        { type: "thinking", thinking: apiKey, signature: apiKey },
        { type: "redacted_thinking", data: apiKey },
        { type: "text", text: text.slice(0, 10) },
        { type: "text", text: text.slice(10), citations: [{ text: apiKey }] },
      ],
    });
    expect(await adapter.requestMove(request)).toEqual({
      ok: true,
      value: { move: "e2e4", commentary: "Center.", latencyMs: 0, usage: null },
    });
  });

  it.each([
    { content: [] },
    { content: [{ type: "thinking", thinking: '{"move":"e2e4"}' }] },
    { content: [{ type: "tool_use", input: { move: "e2e4" } }] },
    { content: [{ type: "text", text: 42 }] },
    ...[
      "max_tokens",
      "stop_sequence",
      "tool_use",
      "pause_turn",
      "refusal",
      "model_context_window_exceeded",
    ].map((stop_reason) => ({ stop_reason })),
    { stop_details: { type: "refusal", explanation: apiKey } },
    { content: [{ type: "text", text: JSON.stringify({ move: "e2e4", commentary: null }) }] },
    {
      content: [
        { type: "text", text: JSON.stringify({ move: "e2e4", commentary: "x".repeat(2001) }) },
      ],
    },
  ])(
    "rejects unusable or incomplete generation even when a legal move is present",
    async (change) => {
      const { adapter } = fixture({
        ...anthropicMessage(),
        ...change,
        usage: { input_tokens: 30, output_tokens: 12 },
      });
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind: "model_invalid", reason: "malformed_output" },
        latencyMs: 0,
        usage: { inputTokens: 30, outputTokens: 12, totalTokens: null },
      });
    },
  );

  it.each([
    [undefined, null],
    [null, null],
    [{}, null],
    ["unavailable", null],
    [{ input_tokens: -1, output_tokens: "2" }, null],
    [{ input_tokens: 0 }, { inputTokens: 0, outputTokens: null, totalTokens: null }],
    [
      { input_tokens: 30, output_tokens: 12 },
      { inputTokens: 30, outputTokens: 12, totalTokens: null },
    ],
    [
      { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 12 },
      { inputTokens: null, outputTokens: 12, totalTokens: null },
    ],
    [
      {
        input_tokens: 30,
        output_tokens: 12,
        total_tokens: 999,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        output_tokens_details: { thinking_tokens: 8 },
        metadata: apiKey,
      },
      { inputTokens: 180, outputTokens: 12, totalTokens: null },
    ],
    [
      { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 100 },
      { inputTokens: null, outputTokens: 12, totalTokens: null },
    ],
    [
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: null },
    ],
    [
      {
        input_tokens: 30,
        output_tokens: 12,
        cache_read_input_tokens: "bad",
        cache_creation_input_tokens: 0,
      },
      { inputTokens: null, outputTokens: 12, totalTokens: null },
    ],
    [
      {
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 12,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0,
      },
      { inputTokens: null, outputTokens: 12, totalTokens: null },
    ],
  ])("retains only reported counts without inventing totals (%j)", async (usage, expected) => {
    const { adapter } = fixture({ ...anthropicMessage(), usage });
    const result = await adapter.requestMove(request);
    expect(result.ok && result.value.usage).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it.each([undefined, "https://example.test/token", "msg_123", "req_" + "x".repeat(200)])(
    "omits unverified request identifiers (%j)",
    async (id) => {
      const { fetch, adapter } = fixture();
      fetch.mockImplementation(async (_url, init) =>
        Response.json(init?.method === "GET" ? anthropicModelInfo() : anthropicMessage(), {
          headers: id ? { "request-id": id } : {},
        }),
      );
      const result = await adapter.requestMove(request);
      expect(result.ok && result.value.providerRequestId).toBeUndefined();
    },
  );

  it("reports message request ID and complete attempt latency including metadata and body consumption", async () => {
    let clock = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      clock += 10;
      if (init?.method === "GET") {
        return Response.json(anthropicModelInfo(), { headers: { "request-id": "req_metadata" } });
      }
      return new Response(
        new ReadableStream({
          start(stream) {
            clock += 25;
            stream.enqueue(new TextEncoder().encode(JSON.stringify(anthropicMessage())));
            stream.close();
          },
        }),
        { headers: { "request-id": "req_move1" } },
      );
    });
    expect(await createAnthropicProvider({ fetch, now: () => clock }).requestMove(request)).toEqual(
      {
        ok: true,
        value: { move: "e2e4", latencyMs: 45, usage: null, providerRequestId: "req_move1" },
      },
    );
  });

  it("rejects credential echoes in commentary", async () => {
    const { adapter } = fixture(anthropicMessage({ move: "e2e4", commentary: apiKey }));
    await expect(adapter.requestMove(request)).rejects.toThrow("INVALID_ANTHROPIC_RESPONSE");
  });
});

describe("Anthropic failures and cancellation", () => {
  it.each([
    [401, "provider_auth"],
    [403, "provider_auth"],
    [402, "provider_quota"],
    [429, "provider_quota"],
    [408, "provider_timeout"],
    [504, "provider_timeout"],
    [400, "provider_unavailable"],
    [404, "provider_unavailable"],
    [413, "provider_unavailable"],
    [500, "provider_unavailable"],
    [529, "provider_unavailable"],
    [302, "provider_unavailable"],
  ])(
    "classifies HTTP %i for discovery, metadata, and Messages without retries",
    async (status, kind) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(apiKey, { status, headers: { "request-id": "req_failure1" } }),
      );
      const adapter = createAnthropicProvider({ fetch, now: () => 0 });
      expect(await adapter.listModels({ apiKey })).toEqual({ ok: false, error: { kind } });
      const failure = {
        ok: false,
        error: { kind },
        latencyMs: 0,
        usage: null,
        providerRequestId: "req_failure1",
      };
      expect(await adapter.requestMove(request)).toEqual(failure);
      fetch.mockResolvedValueOnce(Response.json(anthropicModelInfo()));
      expect(await adapter.requestMove(request)).toEqual(failure);
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    {},
    { ...anthropicMessage(), role: "user" },
    { ...anthropicMessage(), stop_reason: "unknown" },
    { type: "error", error: { type: "overloaded_error", message: apiKey } },
  ])("keeps invalid transport envelopes out of the model-invalid budget", async (body) => {
    const { adapter } = fixture(body);
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error: { kind: "provider_unavailable" },
      latencyMs: 0,
      usage: null,
    });
  });

  it("rejects malformed model metadata before invoking Messages", async () => {
    const { adapter, fetch } = fixture(anthropicMessage(), {});
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error: { kind: "provider_unavailable" },
      latencyMs: 0,
      usage: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "invalid-json", "timeout", "credential-id"])(
    "contains raw %s failures",
    async (mode) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        if (mode === "invalid-json") return new Response(apiKey);
        if (mode === "credential-id") {
          return Response.json(anthropicMessage(), { headers: { "request-id": `req_${apiKey}` } });
        }
        if (mode === "timeout") throw new DOMException(apiKey, "TimeoutError");
        throw new Error(apiKey, { cause: { headers: { "x-api-key": apiKey } } });
      });
      const adapter = createAnthropicProvider({ fetch, now: () => 0 });
      const error = { kind: mode === "timeout" ? "provider_timeout" : "provider_unavailable" };
      expect(await adapter.listModels({ apiKey })).toEqual({ ok: false, error });
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error,
        latencyMs: 0,
        usage: null,
      });
      fetch.mockResolvedValueOnce(Response.json(anthropicModelInfo()));
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error,
        latencyMs: 0,
        usage: null,
      });
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it("honors cancellation before discovery or move I/O", async () => {
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

  it.each(["abort", "timeout"])(
    "cancels pending metadata and message bodies on %s and clears timers",
    async (mode) => {
      vi.useFakeTimers();
      for (const stage of ["metadata", "message"]) {
        const controller = new AbortController();
        const entered = Promise.withResolvers<void>();
        const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
          if (stage === "message" && init?.method === "GET") {
            return Response.json(anthropicModelInfo());
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
          );
        });
        const adapter = createAnthropicProvider({ fetch, timeoutMs: 1000, now: Date.now });
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
        expect(fetch).toHaveBeenCalledTimes(stage === "message" ? 2 : 1);
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );
});
