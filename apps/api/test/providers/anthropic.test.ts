import { describe, expect, it } from "vitest";

import { createAnthropicAdapter } from "../../src/providers/anthropic.js";
import { unknownAnthropicCapabilities } from "../../src/providers/anthropic-capabilities.js";

import { contractInput, PROVIDER_KEY, runAdapterContract } from "./adapter-contract.js";
import {
  anthropicCatalog,
  anthropicError,
  anthropicFixture,
  anthropicModel,
  anthropicResponse,
} from "./anthropic-fixtures.js";
import { mockHttp } from "./mock-http.js";

runAdapterContract(anthropicFixture);
const invalidResponse = { code: "provider_unavailable", reason: "invalid_response" };

describe("Anthropic model discovery", () => {
  it("uses validated cursors at the fixed origin and authenticates every page", async () => {
    const http = mockHttp(
      anthropicFixture.catalog([anthropicFixture.modelId, "future-text-model"]),
    );
    expect(
      await createAnthropicAdapter(http.transport).listModels(contractInput(anthropicFixture)),
    ).toMatchObject({ ok: true });
    expect(http.requests.map(({ url }) => url)).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-4-6",
    ]);
    for (const request of http.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("x-api-key")).toBe(PROVIDER_KEY);
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(request.redirect).toBe("error");
      expect(request.cache).toBe("no-store");
      expect(request.credentials).toBe("omit");
    }
  });

  it("uses live metadata for unfamiliar IDs and does not infer unsupported effort levels", async () => {
    const model = {
      ...anthropicModel("new-account-model"),
      display_name: "New account model",
      max_tokens: 2048,
      capabilities: {
        effort: { supported: true, low: { supported: true }, max: { supported: false } },
      },
    };
    const http = mockHttp([Response.json({ ...anthropicCatalog([model.id]), data: [model] })]);
    expect(
      await createAnthropicAdapter(http.transport).listModels(contractInput(anthropicFixture)),
    ).toEqual({
      ok: true,
      models: [
        {
          provider: "anthropic",
          id: model.id,
          name: model.display_name,
          capabilities: {
            moveGeneration: "supported",
            parameters: {
              temperature: null,
              reasoningEffort: { values: ["low"] },
              maxOutputTokens: { min: 1, max: 2048 },
            },
          },
        },
      ],
    });
  });

  it("does not infer optional controls from absent, empty or disabled capability metadata", async () => {
    for (const capabilities of [
      undefined,
      null,
      {},
      {
        effort: { supported: false, low: { supported: true } },
      },
    ]) {
      const http = mockHttp([
        Response.json({
          ...anthropicCatalog(),
          data: [
            {
              ...anthropicModel(),
              max_tokens: null,
              capabilities,
            },
          ],
        }),
      ]);
      expect(
        await createAnthropicAdapter(http.transport).listModels(contractInput(anthropicFixture)),
      ).toMatchObject({ ok: true, models: [{ capabilities: unknownAnthropicCapabilities }] });
    }
  });

  it.each([
    {},
    { ...anthropicCatalog(), data: {} },
    anthropicCatalog(["duplicate", "duplicate"]),
    anthropicCatalog(["bad\nmodel"]),
    anthropicCatalog(["x".repeat(257)]),
    anthropicCatalog([PROVIDER_KEY], true),
    anthropicCatalog([], true),
    { ...anthropicCatalog(), last_id: PROVIDER_KEY, has_more: true },
    { ...anthropicCatalog(), first_id: null },
    { ...anthropicCatalog(), has_more: "true" },
    ...[
      { display_name: PROVIDER_KEY },
      { display_name: "bad\0name" },
      { display_name: "x".repeat(257) },
      { created_at: "yesterday" },
      { max_tokens: -1 },
      { max_tokens: 0 },
      { max_tokens: 1.5 },
      { max_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { capabilities: { effort: { supported: "true" } } },
      { capabilities: { effort: { supported: true, low: { supported: 1 } } } },
    ].map((fields) => ({ ...anthropicCatalog(), data: [{ ...anthropicModel(), ...fields }] })),
  ])(
    "rejects invalid/secret-bearing catalogs without dispatching another page: %j",
    async (catalog) => {
      const http = mockHttp([Response.json(catalog)]);
      const result = await createAnthropicAdapter(http.transport).listModels(
        contractInput(anthropicFixture),
      );
      expect(result).toEqual({ ok: false, error: invalidResponse });
      expect(JSON.stringify({ result, urls: http.requests.map(({ url }) => url) })).not.toContain(
        PROVIDER_KEY,
      );
      expect(http.transport).toHaveBeenCalledTimes(1);
    },
  );

  it("fails the entire catalog on repeated pages or later-page errors", async () => {
    for (const last of [
      Response.json(anthropicCatalog(undefined, true)),
      anthropicError(403, "permission_error"),
    ]) {
      const http = mockHttp([Response.json(anthropicCatalog(undefined, true)), last]);
      const result = await createAnthropicAdapter(http.transport).listModels(
        contractInput(anthropicFixture),
      );
      expect(result).toEqual({
        ok: false,
        error: last.status === 403 ? { code: "provider_auth" } : invalidResponse,
      });
      expect(http.transport).toHaveBeenCalledTimes(2);
    }
  });

  it("bounds pagination even when every cursor is unique", async () => {
    const http = mockHttp(
      Array.from({ length: 100 }, (_, index) =>
        Response.json(anthropicCatalog([`model-${index}`], true)),
      ),
    );
    expect(
      await createAnthropicAdapter(http.transport).listModels(contractInput(anthropicFixture)),
    ).toEqual({ ok: false, error: invalidResponse });
    expect(http.transport).toHaveBeenCalledTimes(100);
  });
});

describe("Anthropic Messages requests", () => {
  it("sends only the fair context, supported effort and required output limit", async () => {
    const http = mockHttp([Response.json(anthropicResponse())]);
    const input = {
      ...contractInput(anthropicFixture),
      parameters: {
        ...anthropicFixture.parameters,
        temperature: 0.2,
      },
    };
    expect(await createAnthropicAdapter(http.transport).requestMove(input)).toMatchObject({
      ok: true,
    });
    const request = http.requests[0]!;
    const body = (await request.json()) as { messages: { content: string }[] };
    expect(body).toEqual({
      model: input.modelId,
      system: input.instructions,
      messages: [{ role: "user", content: body.messages[0]!.content }],
      max_tokens: 256,
      output_config: { effort: "low" },
      stream: false,
    });
    expect(JSON.parse(body.messages[0]!.content)).toEqual(input.context);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-api-key")).toBe(PROVIDER_KEY);
    expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    expect(request.credentials).toBe("omit");
  });

  it("resolves a mandatory default before dispatch, capped by the current model limit", async () => {
    const http = mockHttp([Response.json(anthropicResponse())]);
    const adapter = createAnthropicAdapter(http.transport);
    const capabilities = {
      ...anthropicFixture.capabilities,
      parameters: {
        ...anthropicFixture.capabilities.parameters,
        maxOutputTokens: { min: 1, max: 512 },
      },
    };
    const parameters = adapter.resolveParameters!({}, capabilities)!;
    expect(parameters).toEqual({ maxOutputTokens: 512 });
    await adapter.requestMove({ ...contractInput(anthropicFixture), capabilities, parameters });
    expect((await anthropicFixture.readMove(http.requests[0]!)).parameters).toEqual(parameters);
  });

  it("attempts unknown models with the required default and no speculative optional fields", async () => {
    const http = mockHttp([Response.json(anthropicResponse())]);
    const input = {
      ...contractInput(anthropicFixture),
      modelId: "future-text-model",
      capabilities: unknownAnthropicCapabilities,
      parameters: { temperature: 0, reasoningEffort: "max", maxOutputTokens: 100_000 },
    };
    const adapter = createAnthropicAdapter(http.transport);
    expect(adapter.resolveParameters!(input.parameters, input.capabilities)).toEqual({
      maxOutputTokens: 1024,
    });
    expect(await adapter.requestMove(input)).toMatchObject({ ok: true });
    expect((await anthropicFixture.readMove(http.requests[0]!)).parameters).toEqual({
      maxOutputTokens: 1024,
    });
  });

  it.each([{ maxOutputTokens: 0 }, { maxOutputTokens: 64_001 }, { reasoningEffort: "xhigh" }])(
    "rejects invalid advertised settings before inference: %j",
    async (parameters) => {
      const http = mockHttp([]);
      expect(
        await createAnthropicAdapter(http.transport).requestMove({
          ...contractInput(anthropicFixture),
          parameters,
        }),
      ).toMatchObject({ ok: false });
      expect(http.transport).not.toHaveBeenCalled();
    },
  );

  it.each(["bad\nmodel", PROVIDER_KEY])(
    "rejects unsafe selected identifiers: %s",
    async (modelId) => {
      const http = mockHttp([]);
      expect(
        await createAnthropicAdapter(http.transport).requestMove({
          ...contractInput(anthropicFixture),
          modelId,
        }),
      ).toMatchObject({ ok: false, error: invalidResponse });
      expect(http.transport).not.toHaveBeenCalled();
    },
  );
});

describe("Anthropic content and usage", () => {
  it("extracts only text blocks, dropping thinking, signatures, IDs and metadata", async () => {
    const http = mockHttp([
      Response.json({
        ...anthropicResponse(),
        id: PROVIDER_KEY,
        model: PROVIDER_KEY,
        content: [
          { type: "thinking", thinking: PROVIDER_KEY, signature: PROVIDER_KEY },
          { type: "redacted_thinking", data: PROVIDER_KEY },
          { type: "text", text: '{"move":', citations: [PROVIDER_KEY] },
          { type: "text", text: '"e7e5"}' },
        ],
        usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60, metadata: PROVIDER_KEY },
      }),
    ]);
    const result = await createAnthropicAdapter(http.transport).requestMove(
      contractInput(anthropicFixture),
    );
    expect(result).toMatchObject({
      ok: true,
      output: { move: "e7e5" },
      providerRequestId: null,
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: null },
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
  ])("does not repair invalid model JSON: %s", async (text) => {
    const http = mockHttp([Response.json(anthropicResponse(text, anthropicFixture.reportedUsage))]);
    expect(
      await createAnthropicAdapter(http.transport).requestMove(contractInput(anthropicFixture)),
    ).toMatchObject({
      ok: false,
      error: { code: "model_invalid", reason: "malformed_output" },
      usage: anthropicFixture.reportedUsage,
    });
  });

  it.each([
    ["max_tokens", { code: "model_invalid", reason: "truncated_output" }],
    ["model_context_window_exceeded", { code: "model_invalid", reason: "truncated_output" }],
    ["refusal", { code: "model_invalid", reason: "refusal" }],
    ["pause_turn", invalidResponse],
    ["tool_use", invalidResponse],
    ["stop_sequence", invalidResponse],
  ])("honors %s even when the text contains valid move JSON", async (stop_reason, error) => {
    const http = mockHttp([
      Response.json({
        ...anthropicResponse(undefined, anthropicFixture.reportedUsage),
        stop_reason,
      }),
    ]);
    expect(
      await createAnthropicAdapter(http.transport).requestMove(contractInput(anthropicFixture)),
    ).toMatchObject({ ok: false, error, usage: anthropicFixture.reportedUsage });
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { usage: { input_tokens: -1 } },
    { usage: { output_tokens: 1.5 } },
    { usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1 } },
    { usage: { cache_read_input_tokens: "invalid" } },
    { usage: "unavailable" },
    { role: "user" },
    { type: "error" },
    { stop_reason: null },
    { stop_reason: "invented" },
    { stop_sequence: "unrequested" },
    { content: [{ type: "text", text: 1 }] },
    { content: [{ type: "tool_use" }] },
    { content: Array.from({ length: 129 }, () => ({ type: "text", text: "" })) },
  ])("classifies malformed envelopes/usage as provider failures: %j", async (fields) => {
    const http = mockHttp([Response.json({ ...anthropicResponse(), ...fields })]);
    expect(
      await createAnthropicAdapter(http.transport).requestMove(contractInput(anthropicFixture)),
    ).toMatchObject({ ok: false, error: invalidResponse });
  });
});

describe("Anthropic transport failures", () => {
  it.each([
    [400, "invalid_request_error", { code: "provider_unavailable", reason: "upstream" }],
    [403, "permission_error", { code: "provider_auth" }],
    [413, "request_too_large", { code: "provider_unavailable", reason: "upstream" }],
    [500, "api_error", { code: "provider_unavailable", reason: "upstream" }],
    [200, "overloaded_error", { code: "provider_unavailable", reason: "upstream" }],
  ])("normalizes HTTP %i/%s without error prose or retries", async (status, type, error) => {
    const http = mockHttp([anthropicError(status, type)]);
    const result = await createAnthropicAdapter(http.transport).requestMove(
      contractInput(anthropicFixture),
    );
    expect(result).toMatchObject({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it.each([401, 402, 403, 429, 504, 529])("classifies non-JSON HTTP %i safely", async (status) => {
    const http = mockHttp([new Response(PROVIDER_KEY, { status })]);
    const result = await createAnthropicAdapter(http.transport).listModels(
      contractInput(anthropicFixture),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code:
          status === 402 || status === 429
            ? "provider_quota"
            : status === 504
              ? "provider_timeout"
              : status === 529
                ? "provider_unavailable"
                : "provider_auth",
      },
    });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel a missing catalog endpoint as a missing model", async () => {
    const http = mockHttp([anthropicError(404, "not_found_error")]);
    expect(
      await createAnthropicAdapter(http.transport).listModels(contractInput(anthropicFixture)),
    ).toEqual({ ok: false, error: { code: "provider_unavailable", reason: "upstream" } });
  });

  it.each(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])(
    "normalizes native fetch timeout %s",
    async (code) => {
      const http = mockHttp([new TypeError(PROVIDER_KEY, { cause: { code } })]);
      const result = await createAnthropicAdapter(http.transport).requestMove(
        contractInput(anthropicFixture),
      );
      expect(result).toMatchObject({ ok: false, error: { code: "provider_timeout" } });
      expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
    },
  );

  it("propagates cancellation while reading a response body", async () => {
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
              stream.enqueue(new TextEncoder().encode('{"type":'));
              entered.resolve();
            },
          }),
        ),
    ]);
    const pending = createAnthropicAdapter(http.transport).requestMove({
      ...contractInput(anthropicFixture),
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

  it("classifies interrupted bodies as network failures", async () => {
    const http = mockHttp([
      new Response(
        new ReadableStream({
          start(stream) {
            stream.error(new TypeError(PROVIDER_KEY));
          },
        }),
      ),
    ]);
    expect(
      await createAnthropicAdapter(http.transport).requestMove(contractInput(anthropicFixture)),
    ).toMatchObject({ ok: false, error: { code: "provider_unavailable", reason: "network" } });
  });

  it.each(["not json", "x".repeat(4 * 1024 * 1024 + 1), new Uint8Array([0xff])])(
    "rejects non-JSON, oversized or invalid UTF-8 bodies",
    async (body) => {
      const http = mockHttp([new Response(body)]);
      expect(
        await createAnthropicAdapter(http.transport).requestMove(contractInput(anthropicFixture)),
      ).toMatchObject({ ok: false, error: invalidResponse });
    },
  );
});
