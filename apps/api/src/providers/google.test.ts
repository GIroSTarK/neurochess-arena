import { createGame } from "@neurochess/chess";
import { type AiConfiguration, modelDiscoveryResultSchema } from "@neurochess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { googleModelInfo, googleModels, googleResponse } from "../../test/google-fixtures.js";
import { providerContractTests } from "../../test/provider-contract.js";

import { buildModelContext, MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { createGoogleProvider } from "./google.js";

const apiKey = "google-key-canary";
const configuration: AiConfiguration = {
  provider: "google",
  modelId: googleModelInfo().name,
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
  name: "Google (mock HTTP)",
  provider: "google",
  modelId: configuration.modelId,
  create(steps) {
    let attempts = 0;
    let clock = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "GET") {
        return Response.json(
          typeof url === "string" && url.includes("models?") ? googleModels() : googleModelInfo(),
        );
      }
      const step = steps[attempts++];
      if (!step) throw new Error("UNEXPECTED_PROVIDER_ATTEMPT");
      clock += step.telemetry?.latencyMs ?? 0;
      if ("error" in step) {
        const status = {
          provider_auth: 403,
          provider_quota: 429,
          provider_timeout: 504,
          provider_unavailable: 503,
        }[step.error.kind];
        return Response.json({ error: { message: apiKey } }, { status });
      }
      const usage = step.telemetry?.usage;
      return Response.json({
        ...googleResponse(step.output),
        usageMetadata: usage
          ? {
              promptTokenCount: usage.inputTokens,
              candidatesTokenCount: usage.outputTokens,
              totalTokenCount: usage.totalTokens,
            }
          : null,
        ...(step.telemetry?.providerRequestId
          ? { responseId: step.telemetry.providerRequestId }
          : {}),
      });
    });
    return { adapter: createGoogleProvider({ fetch, now: () => clock }), attempts: () => attempts };
  },
});

function fixture(response: unknown = googleResponse(), model: unknown = googleModelInfo()) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    Response.json(init?.method === "GET" ? model : response),
  );
  return { fetch, adapter: createGoogleProvider({ fetch, now: () => 0 }) };
}

describe("Google discovery and eligibility", () => {
  it("uses request-only header auth and paginates dynamically, filtering unsupported generation methods", async () => {
    const unknown = {
      name: "models/new-model-2099",
      supportedGenerationMethods: ["generateContent"],
      thinking: true,
    };
    const first = {
      models: [
        googleModelInfo(),
        { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
        { name: "models/live", supportedGenerationMethods: ["bidiGenerateContent"] },
        { name: "models/image", supportedGenerationMethods: ["predict"] },
        { name: "models/no-methods" },
      ],
      nextPageToken: "opaque+/=&next=page",
    };
    const auth: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      auth.push(new Headers(init?.headers).get("x-goog-api-key"));
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("error");
      expect(url).not.toContain(apiKey);
      return Response.json(
        typeof url === "string" && url.includes("pageToken=") ? { models: [unknown] } : first,
      );
    });
    vi.stubEnv("GEMINI_API_KEY", "unused-environment-key");
    vi.stubEnv("GOOGLE_API_KEY", "unused-environment-key");
    const adapter = createGoogleProvider({ fetch });
    expect(fetch).not.toHaveBeenCalled();
    const result = await adapter.listModels({ apiKey });
    expect(modelDiscoveryResultSchema.parse(result)).toEqual({
      ok: true,
      value: [
        {
          provider: "google",
          id: configuration.modelId,
          name: "Gemini 2.5 Flash",
          supportedParameters: {
            temperature: { min: 0, max: 2 },
            maxOutputTokens: { min: 1, max: 65_536 },
          },
        },
        { provider: "google", id: unknown.name, name: unknown.name, supportedParameters: {} },
      ],
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=opaque%2B%2F%3D%26next%3Dpage",
    ]);
    if (result.ok) result.value.splice(0);
    expect(await adapter.listModels({ apiKey: "second-key-canary" })).toMatchObject({ ok: true });
    expect(auth).toEqual([apiKey, apiKey, "second-key-canary", "second-key-canary"]);
    expect(
      fetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has("x-goog-api-key")),
    ).toBe(true);
    expect(JSON.stringify(adapter)).not.toContain(apiKey);
  });

  it.each([{}, { models: [] }, { models: [], nextPageToken: "" }])(
    "accepts empty protobuf catalogs (%j)",
    async (body) => {
      const { adapter } = fixture(undefined, body);
      expect(await adapter.listModels({ apiKey })).toEqual({ ok: true, value: [] });
    },
  );

  it.each([
    null,
    { models: null },
    { error: { message: apiKey } },
    googleModels(["models/duplicate", "models/duplicate"]),
    googleModels(["models/../secret"]),
    googleModels(["models/bad?key=value"]),
    googleModels([`models/${apiKey}`]),
    { models: [{ ...googleModelInfo(), displayName: apiKey }] },
    { models: [{ ...googleModelInfo(), maxTemperature: -1 }] },
    { models: [{ ...googleModelInfo(), outputTokenLimit: 1.5 }] },
    { models: [{ ...googleModelInfo(), thinking: "true" }] },
    { models: [{ ...googleModelInfo(), supportedGenerationMethods: "generateContent" }] },
    { models: [], nextPageToken: apiKey },
    { models: [], nextPageToken: "bad\nheader" },
    googleModels(Array.from({ length: 1001 }, (_, i) => `models/m-${i}`)),
  ])("rejects malformed, duplicated, oversized, or secret-bearing catalogs", async (body) => {
    const { adapter, fetch } = fixture(undefined, body);
    await expect(adapter.listModels({ apiKey })).rejects.toThrow("INVALID_GOOGLE_RESPONSE");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["cursor-loop", "duplicate-id", "oversize", "too-many-pages"])(
    "bounds pagination for %s",
    async (mode) => {
      let page = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        const names = Array.from(
          { length: mode === "oversize" ? 1000 : 1 },
          (_, i) => `models/m-${mode === "duplicate-id" ? 0 : page}-${i}`,
        );
        page++;
        return Response.json({
          ...googleModels(names),
          nextPageToken: mode === "cursor-loop" ? "same" : `page-${page}`,
        });
      });
      await expect(createGoogleProvider({ fetch }).listModels({ apiKey })).rejects.toThrow(
        "INVALID_GOOGLE_RESPONSE",
      );
      expect(fetch).toHaveBeenCalledTimes(mode === "too-many-pages" ? 20 : 2);
    },
  );

  it("discards partial discovery if a later page fails", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...googleModels(), nextPageToken: "next" }))
      .mockResolvedValueOnce(new Response(apiKey, { status: 429 }));
    expect(await createGoogleProvider({ fetch }).listModels({ apiKey })).toEqual({
      ok: false,
      error: { kind: "provider_quota" },
    });
  });
});

describe("Google move requests and capabilities", () => {
  it("sends canonical context, supported zero values, and a legal-move schema without retained conversation state", async () => {
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
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `https://generativelanguage.googleapis.com/v1beta/${configuration.modelId}`,
      `https://generativelanguage.googleapis.com/v1beta/${configuration.modelId}:generateContent`,
    ]);
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ text: MODEL_RESPONSE_INSTRUCTION }, { text: JSON.stringify(context) }],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 200,
        responseFormat: {
          text: {
            mimeType: "application/json",
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
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["gemini-3.8-flash", ["low", "medium", "high"]],
    ["gemini-3.7-flash", ["low", "medium", "high"]],
    ["gemini-3.1-pro-preview", ["low", "medium", "high"]],
    ["gemini-3.6-flash", ["minimal", "low", "medium", "high"]],
    ["gemini-3.5-flash", ["minimal", "low", "medium", "high"]],
    ["gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"]],
    ["gemini-3.1-flash-lite", ["minimal", "low", "medium", "high"]],
    ["gemini-3.1-flash-lite-preview", ["minimal", "low", "medium", "high"]],
    ["gemini-3-flash-preview", ["minimal", "low", "medium", "high"]],
  ] as const)("advertises and sends only verified thinking levels for %s", async (id, levels) => {
    const model = googleModelInfo(`models/${id}`);
    const { adapter, fetch } = fixture(googleResponse(), model);
    fetch.mockResolvedValueOnce(Response.json({ models: [model] }));
    expect(await adapter.listModels({ apiKey })).toMatchObject({
      ok: true,
      value: [{ supportedParameters: { reasoningEffort: { values: levels } } }],
    });
    for (const level of levels) {
      await adapter.requestMove({
        ...request,
        configuration: {
          ...configuration,
          modelId: model.name,
          parameters: { reasoningEffort: level },
        },
      });
      expect(JSON.parse(fetch.mock.lastCall?.[1]?.body as string)).toMatchObject({
        generationConfig: { thinkingConfig: { thinkingLevel: level } },
      });
    }
  });

  it.each([
    "models/new-thinking-model",
    "models/gemini-flash-latest",
    "models/gemini-3.8-flash-20990101",
    "models/gemma-3-27b-it",
  ])("does not infer optional capabilities for %s", async (modelId) => {
    const { adapter, fetch } = fixture(googleResponse(), {
      name: modelId,
      supportedGenerationMethods: ["generateContent"],
      thinking: true,
    });
    await adapter.requestMove({
      ...request,
      configuration: {
        ...configuration,
        modelId,
        parameters: { temperature: 0, maxOutputTokens: 200, reasoningEffort: "high" },
      },
    });
    const body = JSON.parse(fetch.mock.lastCall?.[1]?.body as string) as Record<string, unknown>;
    expect(body.generationConfig).toEqual({});
    expect(body.systemInstruction).toBeUndefined();
  });

  it("honors absent limits, zero temperature ceilings, and an explicit non-thinking capability", async () => {
    const model = {
      ...googleModelInfo("models/gemini-3.8-flash"),
      maxTemperature: 0,
      outputTokenLimit: 0,
      thinking: false,
    };
    const { adapter, fetch } = fixture(googleResponse(), model);
    await adapter.requestMove({
      ...request,
      configuration: {
        ...configuration,
        modelId: model.name,
        parameters: { temperature: 0, maxOutputTokens: 200, reasoningEffort: "high" },
      },
    });
    const body = JSON.parse(fetch.mock.lastCall?.[1]?.body as string) as {
      generationConfig: object;
    };
    expect(body.generationConfig).toHaveProperty("temperature", 0);
    expect(body.generationConfig).not.toHaveProperty("thinkingConfig");
    expect(body.generationConfig).not.toHaveProperty("maxOutputTokens");
  });

  it.each([{ temperature: 2.1 }, { maxOutputTokens: 65_537 }, { reasoningEffort: "minimal" }])(
    "rejects invalid supported values before generation (%j)",
    async (parameters) => {
      const model = googleModelInfo("models/gemini-3.8-flash");
      const { adapter, fetch } = fixture(googleResponse(), model);
      await expect(
        adapter.requestMove({
          ...request,
          configuration: { ...configuration, modelId: model.name, parameters },
        }),
      ).rejects.toThrow("INVALID_GOOGLE_REQUEST");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects invalid inputs and unsafe model paths before I/O", async () => {
    const { adapter, fetch } = fixture();
    for (const input of [
      { ...request, apiKey: "" },
      { ...request, apiKey: "key\r\ninjection" },
      { ...request, configuration: { ...configuration, provider: "openai" } },
      ...[
        "..",
        "models/..",
        "models/../secret",
        "models/x?key=bad",
        "models/x#fragment",
        "models/x%2f..",
        `models/${apiKey}`,
      ].map((modelId) => ({ ...request, configuration: { ...configuration, modelId } })),
      { ...request, configuration: { ...configuration, apiKey } },
      { ...request, configuration: { ...configuration, parameters: { topP: 1 } } },
      { ...request, context: { ...context, opponentModel: apiKey } },
      { ...request, context: { ...context, sideToMove: "black" } },
    ]) {
      await expect(adapter.requestMove(input as typeof request)).rejects.toThrow(
        "INVALID_GOOGLE_REQUEST",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...googleModelInfo(), name: "models/wrong-model" },
    { ...googleModelInfo(), supportedGenerationMethods: ["embedContent"] },
  ])("pauses for unavailable or incompatible metadata before generation", async (model) => {
    const { adapter, fetch } = fixture(googleResponse(), model);
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error: { kind: "provider_unavailable" },
      latencyMs: 0,
      usage: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Google response content and usage", () => {
  it("joins visible text parts and discards thoughts, signatures, and unrelated metadata", async () => {
    const text = JSON.stringify({ move: "e2e4", commentary: "Center." });
    const { adapter } = fixture({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              { thought: true, text: apiKey, thoughtSignature: apiKey },
              { text: text.slice(0, 10), partMetadata: { secret: apiKey } },
              { text: text.slice(10), thoughtSignature: apiKey },
            ],
          },
        },
      ],
    });
    expect(await adapter.requestMove(request)).toEqual({
      ok: true,
      value: { move: "e2e4", commentary: "Center.", latencyMs: 0, usage: null },
    });
  });

  it.each([
    { candidates: [] },
    { candidates: [{}] },
    { candidates: [googleResponse().candidates[0], googleResponse().candidates[0]] },
    { promptFeedback: { blockReason: "SAFETY" } },
    { candidates: googleResponse().candidates, promptFeedback: { blockReason: "BLOCKLIST" } },
    ...[
      undefined,
      "MAX_TOKENS",
      "SAFETY",
      "RECITATION",
      "OTHER",
      "MALFORMED_FUNCTION_CALL",
      "UNEXPECTED_TOOL_CALL",
      "FUTURE_REASON",
    ].map((finishReason) => ({
      candidates: [{ ...googleResponse().candidates[0], finishReason }],
    })),
    ...[
      [],
      [{ text: '{"move":"e2e4"}', thought: true }],
      [{ functionCall: { args: { move: "e2e4" } } }],
      [{ text: '{"move":"e2e4"}', functionCall: {} }],
      [{ text: '{"move":"e2e4"}', inlineData: {} }],
      [{ text: 42 }],
      [{ text: '{"move":"e2e4"}', thought: "true" }],
    ].map((parts) => ({ candidates: [{ finishReason: "STOP", content: { parts } }] })),
    googleResponse({ move: "e2e4", commentary: null }),
    googleResponse({ move: "e2e4", commentary: "x".repeat(2001) }),
  ])(
    "treats absent, incomplete, blocked, ambiguous, and non-text move output as model-invalid",
    async (body) => {
      const { adapter } = fixture({
        ...body,
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12, totalTokenCount: 42 },
      });
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind: "model_invalid", reason: "malformed_output" },
        latencyMs: 0,
        usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
      });
    },
  );

  it.each([
    [undefined, null],
    [null, null],
    [{}, null],
    ["missing", null],
    [{ promptTokenCount: -1, candidatesTokenCount: "12", totalTokenCount: 1.5 }, null],
    [{ promptTokenCount: 0 }, { inputTokens: 0, outputTokens: null, totalTokens: null }],
    [{ candidatesTokenCount: 12 }, { inputTokens: null, outputTokens: 12, totalTokens: null }],
    [{ totalTokenCount: 42 }, { inputTokens: null, outputTokens: null, totalTokens: 42 }],
    [
      { promptTokenCount: 30, candidatesTokenCount: 12 },
      { inputTokens: 30, outputTokens: 12, totalTokens: null },
    ],
    [
      {
        promptTokenCount: Number.MAX_SAFE_INTEGER + 1,
        candidatesTokenCount: 12,
        totalTokenCount: 42,
      },
      { inputTokens: null, outputTokens: 12, totalTokens: 42 },
    ],
    [
      { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ],
    [
      {
        promptTokenCount: 30,
        candidatesTokenCount: 12,
        totalTokenCount: 50,
        cachedContentTokenCount: 10,
        thoughtsTokenCount: 8,
        metadata: apiKey,
      },
      { inputTokens: 30, outputTokens: 12, totalTokens: 50 },
    ],
    [{ thoughtsTokenCount: 8 }, null],
  ])(
    "preserves independently reported counts without inference (%j)",
    async (usageMetadata, expected) => {
      const { adapter } = fixture({ ...googleResponse(), usageMetadata });
      const result = await adapter.requestMove(request);
      expect(result.ok && result.value.usage).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(apiKey);
    },
  );

  it.each([undefined, null, 42, "", "https://example.test/token", "x".repeat(201), "bad\nid"])(
    "drops unverified response IDs (%j)",
    async (responseId) => {
      const { adapter } = fixture({ ...googleResponse(), responseId });
      expect(await adapter.requestMove(request)).toEqual({
        ok: true,
        value: { move: "e2e4", latencyMs: 0, usage: null },
      });
    },
  );

  it.each([
    { ...googleResponse(), responseId: `response_${apiKey}` },
    googleResponse({ move: "e2e4", commentary: apiKey }),
  ])("rejects credential echoes in retained fields", async (body) => {
    const { adapter } = fixture(body);
    await expect(adapter.requestMove(request)).rejects.toThrow("INVALID_GOOGLE_RESPONSE");
  });

  it("measures latency through metadata, generation, and body consumption", async () => {
    let clock = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      clock += 10;
      if (init?.method === "GET") return Response.json(googleModelInfo());
      return new Response(
        new ReadableStream({
          start(stream) {
            clock += 25;
            stream.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ ...googleResponse(), responseId: "google_response-1" }),
              ),
            );
            stream.close();
          },
        }),
      );
    });
    expect(await createGoogleProvider({ fetch, now: () => clock }).requestMove(request)).toEqual({
      ok: true,
      value: { move: "e2e4", latencyMs: 45, usage: null, providerRequestId: "google_response-1" },
    });
  });
});

describe("Google operational failures and cancellation", () => {
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
  ])(
    "classifies HTTP %i across discovery, metadata, and generation without retries",
    async (status, kind) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(apiKey, { status: status }),
      );
      const adapter = createGoogleProvider({ fetch, now: () => 0 });
      expect(await adapter.listModels({ apiKey })).toEqual({ ok: false, error: { kind } });
      const failure = { ok: false, error: { kind }, latencyMs: 0, usage: null };
      expect(await adapter.requestMove(request)).toEqual(failure);
      fetch.mockResolvedValueOnce(Response.json(googleModelInfo()));
      expect(await adapter.requestMove(request)).toEqual(failure);
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it.each(["API_KEY_INVALID", "API_KEY_SERVICE_BLOCKED"])(
    "recognizes typed %s errors even with HTTP 400",
    async (reason) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(
          {
            error: {
              message: apiKey,
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  domain: "googleapis.com",
                  reason,
                  metadata: { key: apiKey },
                },
              ],
            },
          },
          { status: 400 },
        ),
      );
      const adapter = createGoogleProvider({ fetch, now: () => 0 });
      expect(await adapter.listModels({ apiKey })).toEqual({
        ok: false,
        error: { kind: "provider_auth" },
      });
      fetch.mockResolvedValueOnce(Response.json(googleModelInfo()));
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind: "provider_auth" },
        latencyMs: 0,
        usage: null,
      });
    },
  );

  it("does not classify arbitrary upstream messages or untyped details as authentication errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          error: {
            message: `API_KEY_INVALID ${apiKey}`,
            details: [{ reason: "API_KEY_INVALID" }],
          },
        },
        { status: 400 },
      ),
    );
    expect(await createGoogleProvider({ fetch }).listModels({ apiKey })).toEqual({
      ok: false,
      error: { kind: "provider_unavailable" },
    });
  });

  it.each([
    null,
    {},
    { candidates: "invalid" },
    { promptFeedback: "invalid" },
    { error: { message: apiKey } },
  ])("keeps malformed transport envelopes out of the invalid-move budget", async (body) => {
    const { adapter } = fixture(body);
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error: { kind: "provider_unavailable" },
      latencyMs: 0,
      usage: null,
    });
  });

  it.each(["network", "invalid-json", "timeout"])("contains raw %s failures", async (mode) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (mode === "invalid-json") return new Response(apiKey);
      if (mode === "timeout") throw new DOMException(apiKey, "TimeoutError");
      throw new Error(apiKey, { cause: { headers: { "x-goog-api-key": apiKey } } });
    });
    const adapter = createGoogleProvider({ fetch, now: () => 0 });
    const error = { kind: mode === "timeout" ? "provider_timeout" : "provider_unavailable" };
    expect(await adapter.listModels({ apiKey })).toEqual({ ok: false, error });
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error,
      latencyMs: 0,
      usage: null,
    });
    fetch.mockResolvedValueOnce(Response.json(googleModelInfo()));
    expect(await adapter.requestMove(request)).toEqual({
      ok: false,
      error,
      latencyMs: 0,
      usage: null,
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("honors cancellation before provider I/O", async () => {
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
    "cancels pending discovery, metadata, generation, and error bodies on %s",
    async (mode) => {
      vi.useFakeTimers();
      for (const stage of ["discovery", "metadata", "generation", "error"]) {
        const controller = new AbortController();
        const entered = Promise.withResolvers<void>();
        const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
          if (["generation", "error"].includes(stage) && init?.method === "GET") {
            return Response.json(googleModelInfo());
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
            { status: stage === "error" ? 400 : 200 },
          );
        });
        const adapter = createGoogleProvider({ fetch, timeoutMs: 1000, now: Date.now });
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
