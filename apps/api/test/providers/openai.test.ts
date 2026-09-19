import { describe, expect, it } from "vitest";

import { createOpenAiAdapter } from "../../src/providers/openai.js";

import { contractInput, PROVIDER_KEY, runAdapterContract } from "./adapter-contract.js";
import { mockHttp } from "./mock-http.js";
import { openAiCatalog, openAiFixture, openAiResponse } from "./openai-fixtures.js";

runAdapterContract(openAiFixture);

describe("OpenAI Responses API details", () => {
  it.each([
    [
      "gpt-6-astra",
      { maxOutputTokens: 256, reasoningEffort: "low" },
      { max_output_tokens: 256, reasoning: { effort: "low" } },
    ],
    [
      "gpt-5-mini",
      { maxOutputTokens: 256, reasoningEffort: "minimal" },
      { max_output_tokens: 256, reasoning: { effort: "minimal" } },
    ],
    [
      "gpt-5.6",
      { maxOutputTokens: 256, reasoningEffort: "max" },
      { max_output_tokens: 256, reasoning: { effort: "max" } },
    ],
    [
      "gpt-4.1",
      { temperature: 0, maxOutputTokens: 256 },
      { temperature: 0, max_output_tokens: 256 },
    ],
    ["future-text-model", {}, {}],
  ] as const)("translates only supported parameters for %s", async (modelId, effective, sent) => {
    const http = mockHttp([Response.json(openAiResponse())]);
    const input = {
      ...contractInput(openAiFixture),
      modelId,
      parameters: { temperature: 0, reasoningEffort: "low", maxOutputTokens: 256, ...effective },
    };
    expect(await createOpenAiAdapter(http.transport).requestMove(input)).toMatchObject({
      ok: true,
    });
    const body = (await http.requests[0]!.json()) as { input: string };
    expect(body).toEqual({
      model: modelId,
      instructions: input.instructions,
      input: body.input,
      store: false,
      background: false,
      ...sent,
    });
    expect(JSON.parse(body.input)).toEqual(input.context);
    expect(http.requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(http.requests[0]!.method).toBe("POST");
    expect(http.requests[0]!.headers.get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(http.requests[0]!.redirect).toBe("error");
    expect(http.requests[0]!.cache).toBe("no-store");
    expect(http.requests[0]!.credentials).toBe("omit");
  });

  it.each(["text-embedding-3-large", "gpt-image-2", "gpt-4o-mini-transcribe", "gpt-realtime-2"])(
    "marks %s unsupported without invoking it",
    async (modelId) => {
      const http = mockHttp([Response.json(openAiCatalog([modelId]))]);
      const adapter = createOpenAiAdapter(http.transport);
      expect(await adapter.listModels(contractInput(openAiFixture))).toMatchObject({
        ok: true,
        models: [{ id: modelId, capabilities: { moveGeneration: "unsupported" } }],
      });
      expect(await adapter.requestMove({ ...contractInput(openAiFixture), modelId })).toMatchObject(
        { ok: false, error: { code: "provider_unavailable", reason: "unsupported_model" } },
      );
      expect(http.transport).toHaveBeenCalledTimes(1);
    },
  );

  it("does not infer capabilities for unknown variants or fine-tunes", async () => {
    const ids = [
      "gpt-4.1-unannounced",
      "gpt-4o-2024-05-13",
      "ft:gpt-4.1:org:custom:abc",
      "gpt-6-astra-future",
    ];
    const http = mockHttp([Response.json(openAiCatalog(ids))]);
    const result = await createOpenAiAdapter(http.transport).listModels(
      contractInput(openAiFixture),
    );
    expect(
      result.ok &&
        result.models.every(({ capabilities }) => capabilities.moveGeneration === "unknown"),
    ).toBe(true);
  });

  it.each([{ temperature: 3 }, { maxOutputTokens: 15 }, { maxOutputTokens: 32_769 }])(
    "rejects invalid advertised parameters before transport: %j",
    async (parameters) => {
      const http = mockHttp([]);
      expect(
        await createOpenAiAdapter(http.transport).requestMove({
          ...contractInput(openAiFixture),
          parameters,
        }),
      ).toMatchObject({ ok: false });
      expect(http.transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { object: "list", data: {} },
    openAiCatalog(["duplicate", "duplicate"]),
    openAiCatalog(["bad\nmodel"]),
    openAiCatalog(["x".repeat(257)]),
    openAiCatalog([PROVIDER_KEY]),
    { ...openAiCatalog(), has_more: true },
    {
      object: "list",
      data: [{ id: "gpt-4.1", object: "model", created: "yesterday", owned_by: "openai" }],
    },
  ])("rejects malformed, partial, duplicated, or secret-bearing catalogs: %j", async (catalog) => {
    const http = mockHttp([Response.json(catalog)]);
    expect(
      await createOpenAiAdapter(http.transport).listModels(contractInput(openAiFixture)),
    ).toEqual({ ok: false, error: { code: "provider_unavailable", reason: "invalid_response" } });
    expect(http.requests[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(http.requests[0]!.method).toBe("GET");
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it("ignores unneeded discovery metadata and never returns raw owner/response identifiers", async () => {
    const http = mockHttp([
      Response.json({
        ...openAiCatalog(),
        metadata: PROVIDER_KEY,
        data: [{ ...openAiCatalog().data[0], owned_by: PROVIDER_KEY }],
      }),
    ]);
    const result = await createOpenAiAdapter(http.transport).listModels(
      contractInput(openAiFixture),
    );
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
  });

  it("extracts assistant text across blocks, ignoring reasoning and SDK-only output_text", async () => {
    const http = mockHttp([
      Response.json({
        ...openAiResponse(),
        id: PROVIDER_KEY,
        output_text: PROVIDER_KEY,
        output: [
          {
            type: "reasoning",
            id: "rs_fixture",
            summary: [{ type: "summary_text", text: PROVIDER_KEY }],
            encrypted_content: PROVIDER_KEY,
          },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: '{"move":' },
              { type: "output_text", text: '"e7e5"}' },
            ],
          },
        ],
      }),
    ]);
    const result = await createOpenAiAdapter(http.transport).requestMove(
      contractInput(openAiFixture),
    );
    expect(result).toMatchObject({ ok: true, output: { move: "e7e5" }, providerRequestId: null });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
  });

  it.each([
    '{"move":"e5"}',
    '{"move":"e7e5","extra":true}',
    '{"move":"e7e5","commentary":null}',
    '```json\n{"move":"e7e5"}\n```',
    '{"move":',
    JSON.stringify({ move: "e7e5", commentary: "x".repeat(2001) }),
  ])("classifies invalid model JSON without repairing it: %s", async (text) => {
    const http = mockHttp([
      Response.json(openAiResponse(text, { inputTokens: 0, outputTokens: 1, totalTokens: null })),
    ]);
    expect(
      await createOpenAiAdapter(http.transport).requestMove(contractInput(openAiFixture)),
    ).toMatchObject({
      ok: false,
      error: { code: "model_invalid", reason: "malformed_output" },
      usage: { inputTokens: 0, outputTokens: 1, totalTokens: null },
    });
  });

  it.each([
    { usage: { input_tokens: -1 } },
    { usage: { output_tokens: 1.5 } },
    { usage: { total_tokens: Number.MAX_SAFE_INTEGER + 1 } },
    { usage: "unavailable" },
    { output: [{ type: "message", role: "user", status: "completed", content: [] }] },
    { output: [{ type: "message", role: "assistant", status: "in_progress", content: [] }] },
    {
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: 1 }],
        },
      ],
    },
    { output: [{ type: "tool_call" }] },
    { status: "invented" },
    { error: { code: "server_error" } },
    {
      status: "incomplete",
      error: { code: "server_error" },
      incomplete_details: { reason: "max_output_tokens" },
    },
  ])("treats invalid envelope/usage as a provider failure: %j", async (fields) => {
    const http = mockHttp([Response.json({ ...openAiResponse(), ...fields })]);
    expect(
      await createOpenAiAdapter(http.transport).requestMove(contractInput(openAiFixture)),
    ).toMatchObject({
      ok: false,
      error: { code: "provider_unavailable", reason: "invalid_response" },
    });
  });

  it.each([
    [
      { status: "failed", error: { code: "rate_limit_exceeded", message: PROVIDER_KEY } },
      { code: "provider_quota" },
    ],
    [
      { status: "failed", error: { code: "server_error", message: PROVIDER_KEY } },
      { code: "provider_unavailable", reason: "upstream" },
    ],
    [
      { status: "incomplete", incomplete_details: { reason: "content_filter" } },
      { code: "model_invalid", reason: "refusal" },
    ],
    [
      { status: "incomplete", incomplete_details: { reason: "unknown" } },
      { code: "provider_unavailable", reason: "invalid_response" },
    ],
    [
      { status: "incomplete", incomplete_details: null },
      { code: "provider_unavailable", reason: "invalid_response" },
    ],
    [{ status: "queued" }, { code: "provider_unavailable", reason: "invalid_response" }],
    [{ status: "cancelled" }, { code: "provider_unavailable", reason: "cancelled" }],
  ])("normalizes Responses status without returning error text: %j", async (fields, error) => {
    const http = mockHttp([Response.json({ ...openAiResponse(), ...fields })]);
    const result = await createOpenAiAdapter(http.transport).requestMove(
      contractInput(openAiFixture),
    );
    expect(result).toMatchObject({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
  });

  it.each([401, 403, 429, 504, 502])(
    "classifies non-JSON HTTP %i without retrying",
    async (status) => {
      const http = mockHttp([new Response(PROVIDER_KEY, { status })]);
      const code =
        status === 429
          ? "provider_quota"
          : status === 504
            ? "provider_timeout"
            : status === 502
              ? "provider_unavailable"
              : "provider_auth";
      const result = await createOpenAiAdapter(http.transport).listModels(
        contractInput(openAiFixture),
      );
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
      expect(http.transport).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves partial reported usage without computing a missing total", async () => {
    const http = mockHttp([
      Response.json({ ...openAiResponse(), usage: { input_tokens: 50, output_tokens: 10 } }),
    ]);
    expect(
      await createOpenAiAdapter(http.transport).requestMove(contractInput(openAiFixture)),
    ).toMatchObject({ ok: true, usage: { inputTokens: 50, outputTokens: 10, totalTokens: null } });
  });

  it.each(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])(
    "classifies native fetch timeout %s without preserving its cause",
    async (code) => {
      const http = mockHttp([
        new TypeError(PROVIDER_KEY, { cause: { code, message: PROVIDER_KEY } }),
      ]);
      const result = await createOpenAiAdapter(http.transport).requestMove(
        contractInput(openAiFixture),
      );
      expect(result).toMatchObject({ ok: false, error: { code: "provider_timeout" } });
      expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
      expect(http.transport).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates cancellation while consuming the response body", async () => {
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
              stream.enqueue(new TextEncoder().encode('{"object":'));
              entered.resolve();
            },
          }),
        ),
    ]);
    const pending = createOpenAiAdapter(http.transport).requestMove({
      ...contractInput(openAiFixture),
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

  it("classifies an interrupted body as a network failure", async () => {
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
      await createOpenAiAdapter(http.transport).requestMove(contractInput(openAiFixture)),
    ).toMatchObject({ ok: false, error: { code: "provider_unavailable", reason: "network" } });
  });

  it.each(["not json", "x".repeat(4 * 1024 * 1024 + 1)])(
    "rejects non-JSON or oversized responses",
    async (body) => {
      const http = mockHttp([new Response(body)]);
      expect(
        await createOpenAiAdapter(http.transport).requestMove(contractInput(openAiFixture)),
      ).toMatchObject({
        ok: false,
        error: { code: "provider_unavailable", reason: "invalid_response" },
      });
    },
  );
});
