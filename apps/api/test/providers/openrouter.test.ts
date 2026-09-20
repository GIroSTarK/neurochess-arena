import { describe, expect, it } from "vitest";

import { createOpenRouterAdapter } from "../../src/providers/openrouter.js";
import { unknownOpenRouterCapabilities } from "../../src/providers/openrouter-capabilities.js";

import { contractInput, PROVIDER_KEY, runAdapterContract } from "./adapter-contract.js";
import { mockHttp } from "./mock-http.js";
import {
  openRouterCatalog,
  openRouterError,
  openRouterFixture,
  openRouterModel,
  openRouterResponse,
} from "./openrouter-fixtures.js";

runAdapterContract(openRouterFixture);
const invalidResponse = { code: "provider_unavailable", reason: "invalid_response" };
const upstream = { code: "provider_unavailable", reason: "upstream" };
const input = () => contractInput(openRouterFixture);

describe("OpenRouter discovery", () => {
  it("keeps account-filtered pagination at the fixed origin without following upstream links", async () => {
    const http = mockHttp([
      Response.json(
        openRouterCatalog([openRouterFixture.modelId], 2, `https://evil.example/${PROVIDER_KEY}`),
      ),
      Response.json(openRouterCatalog(["future-text-model"], 2)),
    ]);
    expect(await createOpenRouterAdapter(http.transport).listModels(input())).toMatchObject({
      ok: true,
    });
    expect(http.requests.map(({ url }) => url)).toEqual([
      "https://openrouter.ai/api/v1/models/user?offset=0&limit=1000",
      "https://openrouter.ai/api/v1/models/user?offset=1&limit=1000",
    ]);
    for (const request of http.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
      expect(request.redirect).toBe("error");
      expect(request.cache).toBe("no-store");
      expect(request.credentials).toBe("omit");
    }
  });

  it("preserves routed identifiers and variants without a model allowlist", async () => {
    const ids = [
      "vendor/new-model",
      "vendor/new-model:free",
      "vendor/new-model:thinking",
      "openrouter/auto",
      "future-text-model",
    ];
    const http = mockHttp([Response.json(openRouterCatalog(ids))]);
    const result = await createOpenRouterAdapter(http.transport).listModels(input());
    expect(result.ok && result.models.map(({ id }) => id)).toEqual(ids);
  });

  it("uses only advertised modalities, parameter support and per-model reasoning choices", async () => {
    const models = [
      {
        ...openRouterModel("new-model"),
        reasoning: { mandatory: true, supported_efforts: ["high", null, "none"] },
      },
      {
        ...openRouterModel("all-efforts"),
        reasoning: { mandatory: false, supported_efforts: null },
      },
      { ...openRouterModel("no-efforts"), reasoning: { mandatory: true } },
      { ...openRouterModel("no-support"), supported_parameters: [] },
      { ...openRouterModel("no-limits"), top_provider: null },
      {
        ...openRouterModel("output-image"),
        architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      },
      {
        ...openRouterModel("input-audio"),
        architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
      },
      { ...openRouterModel("missing-modality"), architecture: { input_modalities: ["text"] } },
      { id: "unknown" },
    ];
    const http = mockHttp([Response.json({ data: models })]);
    const result = await createOpenRouterAdapter(http.transport).listModels(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const capabilities = result.models.map(({ capabilities }) => capabilities);
    expect(capabilities[0]!.parameters.reasoningEffort).toEqual({ values: ["high"] });
    expect(capabilities[1]!.parameters.reasoningEffort).toEqual({
      values: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
    });
    expect(capabilities[2]!.parameters.reasoningEffort).toBeNull();
    expect(capabilities[3]!.parameters).toEqual(unknownOpenRouterCapabilities.parameters);
    expect(capabilities[4]!.parameters.maxOutputTokens).toBeNull();
    expect(capabilities.slice(5, 7)).toEqual(
      Array.from({ length: 2 }, () => ({
        ...unknownOpenRouterCapabilities,
        moveGeneration: "unsupported",
      })),
    );
    expect(capabilities.slice(7)).toEqual([
      unknownOpenRouterCapabilities,
      unknownOpenRouterCapabilities,
    ]);
  });

  it.each([
    {},
    { data: null },
    openRouterCatalog(["duplicate", "duplicate"]),
    openRouterCatalog([PROVIDER_KEY]),
    { ...openRouterCatalog(), total_count: 0 },
    { ...openRouterCatalog(), total_count: 10_001 },
    { ...openRouterCatalog(), links: { next: 2 } },
    ...[
      { id: "https://evil.example/model" },
      { id: "vendor/../model" },
      { id: "vendor/a?key=value" },
      { id: "vendor/model\n" },
      { id: "x".repeat(257) },
      { name: PROVIDER_KEY },
      { name: "bad\0name" },
      { name: "x".repeat(257) },
      { supported_parameters: "temperature" },
      { supported_parameters: Array.from({ length: 129 }, () => "temperature") },
      { architecture: { input_modalities: "text" } },
      { top_provider: { max_completion_tokens: -1 } },
      { top_provider: { max_completion_tokens: 1.5 } },
      { top_provider: { max_completion_tokens: Number.MAX_SAFE_INTEGER + 1 } },
      { reasoning: { mandatory: "true" } },
      { reasoning: { supported_efforts: ["high", "high"] } },
      { reasoning: { supported_efforts: [PROVIDER_KEY] } },
    ].map((fields) => ({ data: [{ ...openRouterModel(), ...fields }] })),
  ])("rejects malformed or unsafe catalogs: %j", async (catalog) => {
    const http = mockHttp([Response.json(catalog)]);
    const result = await createOpenRouterAdapter(http.transport).listModels(input());
    expect(result).toEqual({ ok: false, error: invalidResponse });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete, duplicated and changing catalogs without returning partial results", async () => {
    for (const last of [
      Response.json(openRouterCatalog([], 2)),
      Response.json(openRouterCatalog([openRouterFixture.modelId], 2)),
      Response.json(openRouterCatalog(["new-model"], 3)),
      Response.json(openRouterCatalog(["new-model"], 2, "unexpected-next")),
      openRouterError(401),
    ]) {
      const http = mockHttp([Response.json(openRouterCatalog(undefined, 2)), last]);
      expect(await createOpenRouterAdapter(http.transport).listModels(input())).toEqual({
        ok: false,
        error: last.status === 401 ? { code: "provider_auth" } : invalidResponse,
      });
      expect(http.transport).toHaveBeenCalledTimes(2);
    }
  });

  it("bounds catalog size and pagination even when metadata is absent", async () => {
    for (const size of [1, 1000]) {
      const pages = size === 1 ? 100 : 10;
      const http = mockHttp(
        Array.from({ length: pages }, (_, page) =>
          Response.json({
            data: Array.from({ length: size }, (_, index) => ({ id: `model-${page}-${index}` })),
            links: { next: "ignored" },
          }),
        ),
      );
      expect(await createOpenRouterAdapter(http.transport).listModels(input())).toEqual({
        ok: false,
        error: invalidResponse,
      });
      expect(http.transport).toHaveBeenCalledTimes(pages);
    }
  });
});

describe("OpenRouter move requests and responses", () => {
  it("sends exactly the fair context and selected parameters while disabling retries and compression", async () => {
    const http = mockHttp([Response.json(openRouterResponse())]);
    const request = { ...input(), modelId: "vendor/new-model:free" };
    expect(await createOpenRouterAdapter(http.transport).requestMove(request)).toMatchObject({
      ok: true,
    });
    expect(http.requests[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = (await http.requests[0]!.json()) as { messages: { content: string }[] };
    expect(JSON.parse(body.messages[1]!.content)).toEqual(request.context);
    expect(body).toEqual({
      model: request.modelId,
      messages: [
        { role: "system", content: request.instructions },
        { role: "user", content: body.messages[1]!.content },
      ],
      stream: false,
      provider: { allow_fallbacks: false, require_parameters: true },
      plugins: [{ id: "context-compression", enabled: false }],
      temperature: 0.5,
      max_tokens: 256,
      reasoning: { effort: "low" },
    });
    expect(http.requests[0]!.redirect).toBe("error");
    expect(http.requests[0]!.credentials).toBe("omit");
  });

  it.each([
    undefined,
    unknownOpenRouterCapabilities,
    { ...openRouterFixture.capabilities, parameters: unknownOpenRouterCapabilities.parameters },
  ])("omits unknown parameters without inventing defaults", async (capabilities) => {
    const http = mockHttp([Response.json(openRouterResponse())]);
    const request = input();
    delete (request as { capabilities?: unknown }).capabilities;
    await createOpenRouterAdapter(http.transport).requestMove({
      ...request,
      ...(capabilities === undefined ? {} : { capabilities }),
    });
    expect((await openRouterFixture.readMove(http.requests[0]!)).parameters).toEqual({});
  });

  it.each([
    { modelId: `vendor/${PROVIDER_KEY}` },
    { modelId: "vendor/../model" },
    { parameters: { temperature: 3 } },
    { parameters: { reasoningEffort: "invented" } },
    { parameters: { maxOutputTokens: 64_001 } },
    { parameters: { maxOutputTokens: -1 } },
    { capabilities: { ...unknownOpenRouterCapabilities, moveGeneration: "unsupported" as const } },
  ])("rejects unsupported models or invalid settings before dispatch: %j", async (fields) => {
    const http = mockHttp([]);
    expect(
      await createOpenRouterAdapter(http.transport).requestMove({ ...input(), ...fields }),
    ).toMatchObject({ ok: false });
    expect(http.transport).not.toHaveBeenCalled();
  });

  it("extracts visible text only and keeps reported token counts independent of reasoning, cache and cost", async () => {
    const response = openRouterResponse();
    const http = mockHttp([
      Response.json({
        ...response,
        id: PROVIDER_KEY,
        provider: PROVIDER_KEY,
        choices: [
          {
            ...response.choices[0],
            message: {
              role: "assistant",
              content: [
                { type: "text", text: '{"move":' },
                { type: "text", text: '"e7e5"}' },
              ],
              reasoning: PROVIDER_KEY,
              reasoning_details: [{ text: PROVIDER_KEY }],
            },
          },
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens_details: { reasoning_tokens: 10 },
          prompt_tokens_details: { cached_tokens: 5 },
          cost: PROVIDER_KEY,
        },
      }),
    ]);
    const result = await createOpenRouterAdapter(http.transport).requestMove(input());
    expect(result).toMatchObject({
      ok: true,
      output: { move: "e7e5" },
      usage: { inputTokens: 50, outputTokens: null, totalTokens: null },
      providerRequestId: null,
    });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
  });

  it.each([
    '{"move":"e5"}',
    '{"move":"e7e5","extra":true}',
    '{"move":"e7e5","commentary":null}',
    '```json\n{"move":"e7e5"}\n```',
    '{"move":',
    "",
    JSON.stringify({ move: "e7e5", commentary: "x".repeat(2001) }),
  ])("does not repair malformed model JSON: %s", async (text) => {
    const http = mockHttp([
      Response.json(openRouterResponse(text, openRouterFixture.reportedUsage)),
    ]);
    expect(await createOpenRouterAdapter(http.transport).requestMove(input())).toMatchObject({
      ok: false,
      error: { code: "model_invalid", reason: "malformed_output" },
      usage: openRouterFixture.reportedUsage,
    });
  });

  it.each([
    ["length", { code: "model_invalid", reason: "truncated_output" }],
    ["content_filter", { code: "model_invalid", reason: "refusal" }],
    ["tool_calls", { code: "model_invalid", reason: "malformed_output" }],
    ["error", upstream],
    ["unknown", invalidResponse],
  ])("honors finish reason %s even alongside valid move JSON", async (finish_reason, error) => {
    const response = openRouterResponse(undefined, openRouterFixture.reportedUsage);
    const http = mockHttp([
      Response.json({ ...response, choices: [{ ...response.choices[0], finish_reason }] }),
    ]);
    expect(await createOpenRouterAdapter(http.transport).requestMove(input())).toMatchObject({
      ok: false,
      error,
      usage: openRouterFixture.reportedUsage,
    });
  });

  it.each([
    {},
    { choices: [] },
    { choices: [openRouterResponse().choices[0], openRouterResponse().choices[0]] },
    ...[
      { index: 1 },
      { finish_reason: null },
      { message: null },
      { message: { role: "user", content: "text" } },
      { message: { role: "assistant", content: [{ type: "image_url", image_url: PROVIDER_KEY }] } },
      { message: { role: "assistant", content: "x".repeat(64_001) } },
    ].map((fields) => ({
      ...openRouterResponse(),
      choices: [{ ...openRouterResponse().choices[0], ...fields }],
    })),
    ...[
      "unavailable",
      { prompt_tokens: -1 },
      { completion_tokens: 1.5 },
      { total_tokens: "50" },
      { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 },
    ].map((usage) => ({ ...openRouterResponse(), usage })),
    ...[null, {}, { code: "429" }, { code: 200 }, { code: 429, metadata: { error_type: 1 } }].map(
      (error) => ({ ...openRouterResponse(), error }),
    ),
  ])(
    "rejects malformed envelopes/usage rather than counting a model-invalid attempt: %j",
    async (response) => {
      const http = mockHttp([Response.json(response)]);
      expect(await createOpenRouterAdapter(http.transport).requestMove(input())).toMatchObject({
        ok: false,
        error: invalidResponse,
      });
    },
  );
});

describe("OpenRouter router and upstream failures", () => {
  it.each([
    [401, 401, undefined, { code: "provider_auth" }],
    [403, 403, undefined, upstream],
    [200, 401, { provider_name: "Upstream" }, upstream],
    [502, 401, { provider_name: "Upstream" }, upstream],
    [200, 429, { provider_name: "Upstream" }, { code: "provider_quota" }],
    [502, 502, { error_type: "rate_limit_exceeded" }, { code: "provider_quota" }],
    [200, 402, { error_type: "payment_required" }, { code: "provider_quota" }],
    [200, 400, { error_type: "token_limit_exceeded" }, { code: "provider_quota" }],
    [
      200,
      400,
      { error_type: "max_tokens_exceeded" },
      { code: "model_invalid", reason: "truncated_output" },
    ],
    [200, 403, { error_type: "refusal" }, { code: "model_invalid", reason: "refusal" }],
    [403, 403, { error_type: "refusal" }, { code: "model_invalid", reason: "refusal" }],
    [200, 403, { error_type: "content_policy_violation" }, upstream],
    [200, 401, { error_type: "authentication" }, upstream],
    [200, 403, { error_type: "permission_denied" }, upstream],
    [
      200,
      404,
      { error_type: "not_found" },
      { code: "provider_unavailable", reason: "unsupported_model" },
    ],
    [200, 502, { error_type: "provider_unavailable" }, invalidResponse],
    [200, 504, { error_type: "timeout" }, { code: "provider_timeout" }],
    [200, 400, { error_type: "context_length_exceeded" }, upstream],
    [200, 400, { error_type: "invalid_request" }, upstream],
    [200, 503, { error_type: "provider_overloaded" }, upstream],
    [200, 500, { error_type: "server" }, upstream],
    [200, 500, { error_type: "unmapped" }, upstream],
    [200, 500, { error_type: "future-code" }, upstream],
  ] as const)("normalizes HTTP %i / error %i / %j", async (status, code, metadata, error) => {
    const http = mockHttp([
      openRouterError(
        status,
        code,
        metadata === undefined ? undefined : { ...metadata, raw: PROVIDER_KEY },
      ),
    ]);
    const result = await createOpenRouterAdapter(http.transport).requestMove(input());
    expect(result).toMatchObject({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it("checks error bodies before choices and preserves only validated usage on failures", async () => {
    for (const malformed of [false, true]) {
      const http = mockHttp([
        Response.json({
          ...openRouterResponse(),
          error: { code: 429, metadata: { error_type: "rate_limit_exceeded", raw: PROVIDER_KEY } },
          usage: { prompt_tokens: malformed ? "10" : 10 },
        }),
      ]);
      expect(await createOpenRouterAdapter(http.transport).requestMove(input())).toMatchObject({
        ok: false,
        error: malformed ? invalidResponse : { code: "provider_quota" },
        usage: malformed ? null : { inputTokens: 10, outputTokens: null, totalTokens: null },
      });
    }
  });

  it.each([404, 403])("never treats discovery HTTP %i as model output", async (code) => {
    const http = mockHttp([
      openRouterError(200, code, { error_type: code === 404 ? "not_found" : "refusal" }),
    ]);
    expect(await createOpenRouterAdapter(http.transport).listModels(input())).toEqual({
      ok: false,
      error: upstream,
    });
  });

  it.each([
    [401, "provider_auth"],
    [402, "provider_quota"],
    [429, "provider_quota"],
    [504, "provider_timeout"],
    [503, "provider_unavailable"],
  ] as const)("handles non-JSON HTTP %i without exposing prose", async (status, code) => {
    const http = mockHttp([new Response(PROVIDER_KEY, { status })]);
    const result = await createOpenRouterAdapter(http.transport).listModels(input());
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
  });

  it.each(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])(
    "normalizes native timeout %s",
    async (code) => {
      const http = mockHttp([new TypeError(PROVIDER_KEY, { cause: { code } })]);
      expect(await createOpenRouterAdapter(http.transport).requestMove(input())).toMatchObject({
        ok: false,
        error: { code: "provider_timeout" },
      });
    },
  );

  it("propagates cancellation while reading the response body", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const http = mockHttp([
      (request) =>
        new Response(
          new ReadableStream({
            start(stream) {
              request.signal.addEventListener(
                "abort",
                () => stream.error(new Error(PROVIDER_KEY)),
                { once: true },
              );
              stream.enqueue(new TextEncoder().encode('{"choices":'));
              entered.resolve();
            },
          }),
        ),
    ]);
    const pending = createOpenRouterAdapter(http.transport).requestMove({
      ...input(),
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "provider_unavailable", reason: "cancelled" },
    });
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it.each(["not json", "x".repeat(4 * 1024 * 1024 + 1), new Uint8Array([0xff])])(
    "rejects invalid JSON, oversized and non-UTF-8 bodies",
    async (body) => {
      const http = mockHttp([new Response(body)]);
      expect(await createOpenRouterAdapter(http.transport).requestMove(input())).toMatchObject({
        ok: false,
        error: invalidResponse,
      });
    },
  );
});
