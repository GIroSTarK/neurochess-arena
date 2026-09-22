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
    { name: "missing data", catalog: {} },
    { name: "null data", catalog: { data: null } },
    { name: "duplicate model IDs", catalog: openRouterCatalog(["duplicate", "duplicate"]) },
    { name: "credential in model ID", catalog: openRouterCatalog([PROVIDER_KEY]) },
    { name: "total below page size", catalog: { ...openRouterCatalog(), total_count: 0 } },
    { name: "total above catalog limit", catalog: { ...openRouterCatalog(), total_count: 10_001 } },
    { name: "non-string next link", catalog: { ...openRouterCatalog(), links: { next: 2 } } },
    ...[
      { name: "absolute URL model ID", fields: { id: "https://evil.example/model" } },
      { name: "parent traversal model ID", fields: { id: "vendor/../model" } },
      { name: "query in model ID", fields: { id: "vendor/a?key=value" } },
      { name: "newline in model ID", fields: { id: "vendor/model\n" } },
      { name: "oversized model ID", fields: { id: "x".repeat(257) } },
      { name: "credential in model name", fields: { name: PROVIDER_KEY } },
      { name: "NUL in model name", fields: { name: "bad\0name" } },
      { name: "oversized model name", fields: { name: "x".repeat(257) } },
      { name: "non-array parameters", fields: { supported_parameters: "temperature" } },
      {
        name: "too many parameters",
        fields: { supported_parameters: Array.from({ length: 129 }, () => "temperature") },
      },
      {
        name: "non-array input modalities",
        fields: { architecture: { input_modalities: "text" } },
      },
      { name: "negative output limit", fields: { top_provider: { max_completion_tokens: -1 } } },
      { name: "fractional output limit", fields: { top_provider: { max_completion_tokens: 1.5 } } },
      {
        name: "unsafe output limit integer",
        fields: { top_provider: { max_completion_tokens: Number.MAX_SAFE_INTEGER + 1 } },
      },
      { name: "non-boolean mandatory reasoning", fields: { reasoning: { mandatory: "true" } } },
      {
        name: "duplicate reasoning efforts",
        fields: { reasoning: { supported_efforts: ["high", "high"] } },
      },
      {
        name: "credential in reasoning effort",
        fields: { reasoning: { supported_efforts: [PROVIDER_KEY] } },
      },
    ].map(({ name, fields }) => ({
      name,
      catalog: { data: [{ ...openRouterModel(), ...fields }] },
    })),
  ])("rejects invalid catalogs: $name", async ({ catalog }) => {
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
    { name: "absent capabilities", capabilities: undefined },
    { name: "unknown capabilities", capabilities: unknownOpenRouterCapabilities },
    {
      name: "known model with unknown parameter support",
      capabilities: {
        ...openRouterFixture.capabilities,
        parameters: unknownOpenRouterCapabilities.parameters,
      },
    },
  ])("omits unknown parameters: $name", async ({ capabilities }) => {
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
    { name: "credential in model ID", fields: { modelId: `vendor/${PROVIDER_KEY}` } },
    { name: "parent traversal model ID", fields: { modelId: "vendor/../model" } },
    { name: "temperature above maximum", fields: { parameters: { temperature: 3 } } },
    {
      name: "unsupported reasoning effort",
      fields: { parameters: { reasoningEffort: "invented" } },
    },
    { name: "output tokens above maximum", fields: { parameters: { maxOutputTokens: 64_001 } } },
    { name: "negative output tokens", fields: { parameters: { maxOutputTokens: -1 } } },
    {
      name: "unsupported move generation",
      fields: {
        capabilities: { ...unknownOpenRouterCapabilities, moveGeneration: "unsupported" as const },
      },
    },
  ])("rejects models or settings before dispatch: $name", async ({ fields }) => {
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
    { name: "SAN move", text: '{"move":"e5"}' },
    { name: "extra field", text: '{"move":"e7e5","extra":true}' },
    { name: "null commentary", text: '{"move":"e7e5","commentary":null}' },
    { name: "Markdown fence", text: '```json\n{"move":"e7e5"}\n```' },
    { name: "incomplete JSON", text: '{"move":' },
    { name: "empty text", text: "" },
    {
      name: "oversized commentary",
      text: JSON.stringify({ move: "e7e5", commentary: "x".repeat(2001) }),
    },
  ])("rejects malformed model JSON: $name", async ({ text }) => {
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
    { name: "missing choices", response: {} },
    { name: "empty choices", response: { choices: [] } },
    {
      name: "multiple choices",
      response: { choices: [openRouterResponse().choices[0], openRouterResponse().choices[0]] },
    },
    ...[
      { name: "nonzero choice index", fields: { index: 1 } },
      { name: "null finish reason", fields: { finish_reason: null } },
      { name: "null message", fields: { message: null } },
      { name: "user message role", fields: { message: { role: "user", content: "text" } } },
      {
        name: "image content",
        fields: {
          message: { role: "assistant", content: [{ type: "image_url", image_url: PROVIDER_KEY }] },
        },
      },
      {
        name: "oversized visible content",
        fields: { message: { role: "assistant", content: "x".repeat(64_001) } },
      },
    ].map(({ name, fields }) => ({
      name,
      response: {
        ...openRouterResponse(),
        choices: [{ ...openRouterResponse().choices[0], ...fields }],
      },
    })),
    ...[
      { name: "non-object usage", usage: "unavailable" },
      { name: "negative prompt tokens", usage: { prompt_tokens: -1 } },
      { name: "fractional completion tokens", usage: { completion_tokens: 1.5 } },
      { name: "non-numeric total tokens", usage: { total_tokens: "50" } },
      {
        name: "unsafe prompt token integer",
        usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 },
      },
    ].map(({ name, usage }) => ({ name, response: { ...openRouterResponse(), usage } })),
    ...[
      { name: "null error", error: null },
      { name: "empty error", error: {} },
      { name: "non-numeric error code", error: { code: "429" } },
      { name: "success error code", error: { code: 200 } },
      { name: "non-string error type", error: { code: 429, metadata: { error_type: 1 } } },
    ].map(({ name, error }) => ({ name, response: { ...openRouterResponse(), error } })),
  ])("rejects malformed envelopes or usage: $name", async ({ response }) => {
    const http = mockHttp([Response.json(response)]);
    expect(await createOpenRouterAdapter(http.transport).requestMove(input())).toMatchObject({
      ok: false,
      error: invalidResponse,
    });
  });
});

describe("OpenRouter router and upstream failures", () => {
  it.each([
    {
      name: "HTTP 401 router auth without metadata",
      status: 401,
      code: 401,
      metadata: undefined,
      error: { code: "provider_auth" },
    },
    {
      name: "HTTP 401 router auth with null type",
      status: 401,
      code: 401,
      metadata: { error_type: null },
      error: { code: "provider_auth" },
    },
    {
      name: "HTTP 401 router auth with null provider fields",
      status: 401,
      code: 401,
      metadata: { provider_name: null, provider_code: null },
      error: { code: "provider_auth" },
    },
    {
      name: "HTTP 200 quota with all metadata null",
      status: 200,
      code: 429,
      metadata: { error_type: null, provider_name: null, provider_code: null },
      error: { code: "provider_quota" },
    },
    {
      name: "HTTP 401 upstream named with null type and code",
      status: 401,
      code: 401,
      metadata: { error_type: null, provider_name: "Upstream", provider_code: null },
      error: upstream,
    },
    {
      name: "HTTP 401 upstream auth code with null type and name",
      status: 401,
      code: 401,
      metadata: { error_type: null, provider_name: null, provider_code: "invalid_api_key" },
      error: upstream,
    },
    {
      name: "HTTP 200 unavailable with null provider fields",
      status: 200,
      code: 502,
      metadata: { error_type: "provider_unavailable", provider_name: null, provider_code: null },
      error: invalidResponse,
    },
    {
      name: "HTTP 200 rate limit with null provider fields",
      status: 200,
      code: 502,
      metadata: { error_type: "rate_limit_exceeded", provider_name: null, provider_code: null },
      error: { code: "provider_quota" },
    },
    {
      name: "HTTP 403 ambiguous denial",
      status: 403,
      code: 403,
      metadata: undefined,
      error: upstream,
    },
    {
      name: "HTTP 200 upstream auth",
      status: 200,
      code: 401,
      metadata: { provider_name: "Upstream" },
      error: upstream,
    },
    {
      name: "HTTP 502 upstream auth",
      status: 502,
      code: 401,
      metadata: { provider_name: "Upstream" },
      error: upstream,
    },
    {
      name: "HTTP 200 upstream quota",
      status: 200,
      code: 429,
      metadata: { provider_name: "Upstream" },
      error: { code: "provider_quota" },
    },
    {
      name: "HTTP 502 wrapped rate limit",
      status: 502,
      code: 502,
      metadata: { error_type: "rate_limit_exceeded" },
      error: { code: "provider_quota" },
    },
    {
      name: "HTTP 200 payment required",
      status: 200,
      code: 402,
      metadata: { error_type: "payment_required" },
      error: { code: "provider_quota" },
    },
    {
      name: "HTTP 200 token limit",
      status: 200,
      code: 400,
      metadata: { error_type: "token_limit_exceeded" },
      error: { code: "provider_quota" },
    },
    {
      name: "HTTP 200 output truncation",
      status: 200,
      code: 400,
      metadata: { error_type: "max_tokens_exceeded" },
      error: { code: "model_invalid", reason: "truncated_output" },
    },
    {
      name: "HTTP 200 refusal",
      status: 200,
      code: 403,
      metadata: { error_type: "refusal" },
      error: { code: "model_invalid", reason: "refusal" },
    },
    {
      name: "HTTP 403 refusal",
      status: 403,
      code: 403,
      metadata: { error_type: "refusal" },
      error: { code: "model_invalid", reason: "refusal" },
    },
    {
      name: "HTTP 200 content policy",
      status: 200,
      code: 403,
      metadata: { error_type: "content_policy_violation" },
      error: upstream,
    },
    {
      name: "HTTP 200 upstream authentication type",
      status: 200,
      code: 401,
      metadata: { error_type: "authentication" },
      error: upstream,
    },
    {
      name: "HTTP 200 permission denial",
      status: 200,
      code: 403,
      metadata: { error_type: "permission_denied" },
      error: upstream,
    },
    {
      name: "HTTP 200 model not found",
      status: 200,
      code: 404,
      metadata: { error_type: "not_found" },
      error: { code: "provider_unavailable", reason: "unsupported_model" },
    },
    {
      name: "HTTP 200 unavailable without provider fields",
      status: 200,
      code: 502,
      metadata: { error_type: "provider_unavailable" },
      error: invalidResponse,
    },
    {
      name: "HTTP 200 timeout",
      status: 200,
      code: 504,
      metadata: { error_type: "timeout" },
      error: { code: "provider_timeout" },
    },
    {
      name: "HTTP 200 context length",
      status: 200,
      code: 400,
      metadata: { error_type: "context_length_exceeded" },
      error: upstream,
    },
    {
      name: "HTTP 200 invalid request",
      status: 200,
      code: 400,
      metadata: { error_type: "invalid_request" },
      error: upstream,
    },
    {
      name: "HTTP 200 overload",
      status: 200,
      code: 503,
      metadata: { error_type: "provider_overloaded" },
      error: upstream,
    },
    {
      name: "HTTP 200 server error",
      status: 200,
      code: 500,
      metadata: { error_type: "server" },
      error: upstream,
    },
    {
      name: "HTTP 200 unmapped error",
      status: 200,
      code: 500,
      metadata: { error_type: "unmapped" },
      error: upstream,
    },
    {
      name: "HTTP 200 future error type",
      status: 200,
      code: 500,
      metadata: { error_type: "future-code" },
      error: upstream,
    },
  ] as const)("normalizes router error: $name", async ({ status, code, metadata, error }) => {
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

  it.each([
    { name: "invalid JSON", body: "not json" },
    { name: "oversized body", body: "x".repeat(4 * 1024 * 1024 + 1) },
    { name: "invalid UTF-8", body: new Uint8Array([0xff]) },
  ])("rejects response body: $name", async ({ body }) => {
    const http = mockHttp([new Response(body)]);
    expect(await createOpenRouterAdapter(http.transport).requestMove(input())).toMatchObject({
      ok: false,
      error: invalidResponse,
    });
  });
});
