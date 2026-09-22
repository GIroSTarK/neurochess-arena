import { describe, expect, it } from "vitest";

import { createGoogleAdapter } from "../../src/providers/google.js";
import { unknownGoogleCapabilities } from "../../src/providers/google-capabilities.js";

import { contractInput, PROVIDER_KEY, runAdapterContract } from "./adapter-contract.js";
import {
  googleCatalog,
  googleError,
  googleFixture,
  googleModel,
  googleResponse,
} from "./google-fixtures.js";
import { mockHttp } from "./mock-http.js";

runAdapterContract(googleFixture);
const invalidResponse = { code: "provider_unavailable", reason: "invalid_response" };

describe("Google discovery", () => {
  it("encodes opaque cursors, keeps the fixed origin, and authenticates every page", async () => {
    const http = mockHttp(googleFixture.catalog([googleFixture.modelId, "future-text-model"]));
    expect(
      await createGoogleAdapter(http.transport).listModels(contractInput(googleFixture)),
    ).toMatchObject({ ok: true });
    expect(http.requests.map(({ url }) => url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=next-page%2B%2F%3D",
    ]);
    for (const request of http.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("x-goog-api-key")).toBe(PROVIDER_KEY);
      expect(request.redirect).toBe("error");
      expect(request.cache).toBe("no-store");
      expect(request.credentials).toBe("omit");
    }
  });

  it("uses live methods and limits for new IDs, retaining unavailable and unknown models", async () => {
    const http = mockHttp([
      Response.json({
        models: [
          {
            ...googleModel("new-model"),
            displayName: "New model",
            outputTokenLimit: 512,
            maxTemperature: 0.8,
          },
          {
            ...googleModel("embedding-model"),
            supportedGenerationMethods: ["embedContent", "countTokens"],
          },
          { ...googleModel("live-model"), supportedGenerationMethods: ["bidiGenerateContent"] },
          { ...googleModel("empty-methods"), supportedGenerationMethods: [] },
          { ...googleModel("unknown-model"), supportedGenerationMethods: undefined },
          {
            name: "models/method-only",
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
          },
        ],
      }),
    ]);
    const result = await createGoogleAdapter(http.transport).listModels(
      contractInput(googleFixture),
    );
    expect(result).toEqual({
      ok: true,
      models: [
        {
          provider: "google",
          id: "new-model",
          name: "New model",
          capabilities: {
            moveGeneration: "supported",
            parameters: {
              temperature: { min: 0, max: 0.8 },
              reasoningEffort: null,
              maxOutputTokens: { min: 1, max: 512 },
            },
          },
        },
        ...["embedding-model", "live-model", "empty-methods"].map((id) => ({
          provider: "google",
          id,
          name: id,
          capabilities: { ...unknownGoogleCapabilities, moveGeneration: "unsupported" },
        })),
        {
          provider: "google",
          id: "unknown-model",
          name: "unknown-model",
          capabilities: unknownGoogleCapabilities,
        },
        {
          provider: "google",
          id: "method-only",
          name: "method-only",
          capabilities: { ...unknownGoogleCapabilities, moveGeneration: "supported" },
        },
      ],
    });
  });

  it.each([
    { name: "omitted models", catalog: {} },
    { name: "empty models", catalog: { models: [] } },
    { name: "empty models and cursor", catalog: { models: [], nextPageToken: "" } },
  ])("accepts empty protobuf catalog: $name", async ({ catalog }) => {
    const http = mockHttp([Response.json(catalog)]);
    expect(
      await createGoogleAdapter(http.transport).listModels(contractInput(googleFixture)),
    ).toEqual({ ok: true, models: [] });
  });

  it.each([
    { name: "non-array models", catalog: { models: {} } },
    { name: "null models", catalog: { models: null } },
    { name: "cursor without models", catalog: { nextPageToken: "next" } },
    { name: "duplicate model IDs", catalog: googleCatalog(["duplicate", "duplicate"]) },
    { name: "credential in model ID", catalog: googleCatalog([PROVIDER_KEY]) },
    ...[
      { name: "credential in cursor", nextPageToken: PROVIDER_KEY },
      { name: "embedded newline in cursor", nextPageToken: "line\nbreak" },
      { name: "trailing newline in cursor", nextPageToken: "trailing\n" },
      { name: "oversized cursor", nextPageToken: "x".repeat(2049) },
      { name: "numeric cursor", nextPageToken: 1 },
      { name: "null cursor", nextPageToken: null },
    ].map(({ name, nextPageToken }) => ({
      name,
      catalog: {
        ...googleCatalog(),
        nextPageToken,
      },
    })),
    ...[
      { name: "absolute URL model name", fields: { name: "https://evil.example/model" } },
      { name: "nested model path", fields: { name: "models/a/b" } },
      { name: "parent traversal model name", fields: { name: "models/../models" } },
      { name: "method suffix in model name", fields: { name: "models/a:generateContent" } },
      { name: "query in model name", fields: { name: "models/a?key=value" } },
      { name: "encoded slash in model name", fields: { name: "models/a%2fb" } },
      { name: "newline in model name", fields: { name: "models/bad\n" } },
      { name: "oversized model name", fields: { name: `models/${"x".repeat(257)}` } },
      { name: "credential in display name", fields: { displayName: PROVIDER_KEY } },
      { name: "NUL in display name", fields: { displayName: "bad\0name" } },
      { name: "newline in display name", fields: { displayName: "trailing\n" } },
      { name: "oversized display name", fields: { displayName: "x".repeat(129) } },
      {
        name: "non-array generation methods",
        fields: { supportedGenerationMethods: "generateContent" },
      },
      { name: "non-string generation method", fields: { supportedGenerationMethods: [1] } },
      {
        name: "too many generation methods",
        fields: {
          supportedGenerationMethods: Array.from({ length: 129 }, () => "generateContent"),
        },
      },
      { name: "negative output limit", fields: { outputTokenLimit: -1 } },
      { name: "zero output limit", fields: { outputTokenLimit: 0 } },
      { name: "fractional output limit", fields: { outputTokenLimit: 1.5 } },
      {
        name: "unsafe output limit integer",
        fields: { outputTokenLimit: Number.MAX_SAFE_INTEGER + 1 },
      },
      { name: "negative maximum temperature", fields: { maxTemperature: -1 } },
      { name: "non-numeric maximum temperature", fields: { maxTemperature: "2" } },
    ].map(({ name, fields }) => ({ name, catalog: { models: [{ ...googleModel(), ...fields }] } })),
  ])("rejects invalid catalogs: $name", async ({ catalog }) => {
    const http = mockHttp([Response.json(catalog)]);
    const result = await createGoogleAdapter(http.transport).listModels(
      contractInput(googleFixture),
    );
    expect(result).toEqual({ ok: false, error: invalidResponse });
    expect(JSON.stringify({ result, urls: http.requests.map(({ url }) => url) })).not.toContain(
      PROVIDER_KEY,
    );
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate IDs, cursor cycles and failed later pages without returning partial catalogs", async () => {
    for (const last of [
      Response.json(googleCatalog()),
      Response.json(googleCatalog(["different-model"], "next")),
      googleError(403, "PERMISSION_DENIED"),
    ]) {
      const http = mockHttp([Response.json(googleCatalog(undefined, "next")), last]);
      expect(
        await createGoogleAdapter(http.transport).listModels(contractInput(googleFixture)),
      ).toEqual({
        ok: false,
        error: last.status === 403 ? { code: "provider_auth" } : invalidResponse,
      });
      expect(http.transport).toHaveBeenCalledTimes(2);
    }
  });

  it("bounds catalog size and page count with distinct IDs and tokens", async () => {
    for (const pageSize of [1, 1000]) {
      const pages = pageSize === 1 ? 100 : 10;
      const http = mockHttp(
        Array.from({ length: pages }, (_, page) =>
          Response.json(
            googleCatalog(
              Array.from({ length: pageSize }, (_, index) => `model-${page}-${index}`),
              `page-${page}`,
            ),
          ),
        ),
      );
      expect(
        await createGoogleAdapter(http.transport).listModels(contractInput(googleFixture)),
      ).toEqual({ ok: false, error: invalidResponse });
      expect(http.transport).toHaveBeenCalledTimes(pages);
    }
  });
});

describe("Google generation requests", () => {
  it("sends only fair context and advertised parameters without tools, caching or thinking controls", async () => {
    const http = mockHttp([Response.json(googleResponse())]);
    const input = {
      ...contractInput(googleFixture),
      parameters: { ...googleFixture.parameters, reasoningEffort: "high" },
    };
    expect(await createGoogleAdapter(http.transport).requestMove(input)).toMatchObject({
      ok: true,
    });
    const request = http.requests[0]!;
    const body = (await request.json()) as { contents: { parts: { text: string }[] }[] };
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: input.instructions }] },
      contents: [{ role: "user", parts: [{ text: body.contents[0]!.parts[0]!.text }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 256 },
      store: false,
    });
    expect(JSON.parse(body.contents[0]!.parts[0]!.text)).toEqual(input.context);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-goog-api-key")).toBe(PROVIDER_KEY);
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    expect(request.credentials).toBe("omit");
  });

  it.each([
    { name: "absent capabilities", capabilities: undefined },
    { name: "unknown capabilities", capabilities: unknownGoogleCapabilities },
  ])("omits optional fields with $name", async ({ capabilities }) => {
    const http = mockHttp([Response.json(googleResponse())]);
    const input = { ...contractInput(googleFixture), modelId: "future-text-model" };
    if (capabilities === undefined) delete input.capabilities;
    else input.capabilities = capabilities;
    expect(await createGoogleAdapter(http.transport).requestMove(input)).toMatchObject({
      ok: true,
    });
    expect(await http.requests[0]!.json()).not.toHaveProperty("generationConfig");
  });

  it("rejects non-generation models without inference", async () => {
    const http = mockHttp([]);
    expect(
      await createGoogleAdapter(http.transport).requestMove({
        ...contractInput(googleFixture),
        capabilities: { ...unknownGoogleCapabilities, moveGeneration: "unsupported" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "provider_unavailable", reason: "unsupported_model" },
    });
    expect(http.transport).not.toHaveBeenCalled();
  });

  it.each([
    { name: "zero output tokens", parameters: { maxOutputTokens: 0 } },
    { name: "output tokens above maximum", parameters: { maxOutputTokens: 65_537 } },
    { name: "temperature above maximum", parameters: { temperature: 2.1 } },
    { name: "negative temperature", parameters: { temperature: -1 } },
  ])("rejects invalid settings: $name", async ({ parameters }) => {
    const http = mockHttp([]);
    expect(
      await createGoogleAdapter(http.transport).requestMove({
        ...contractInput(googleFixture),
        parameters,
      }),
    ).toMatchObject({ ok: false });
    expect(http.transport).not.toHaveBeenCalled();
  });

  it.each([
    { name: "newline", modelId: "bad\nmodel" },
    { name: "credential echo", modelId: PROVIDER_KEY },
    { name: "resource prefix", modelId: "models/gemini-2.5-flash" },
    { name: "parent traversal", modelId: "../models" },
    { name: "nested path", modelId: "a/b" },
    { name: "query", modelId: "a?key=value" },
    { name: "method suffix", modelId: "a:generateContent" },
    { name: "encoded slash", modelId: "a%2fb" },
  ])("rejects unsafe model ID: $name", async ({ modelId }) => {
    const http = mockHttp([]);
    expect(
      await createGoogleAdapter(http.transport).requestMove({
        ...contractInput(googleFixture),
        modelId,
      }),
    ).toMatchObject({ ok: false, error: invalidResponse });
    expect(http.transport).not.toHaveBeenCalled();
  });
});

describe("Google candidates and usage", () => {
  it("joins visible text only and drops thoughts, signatures, response identifiers and metadata", async () => {
    const http = mockHttp([
      Response.json({
        ...googleResponse(),
        responseId: PROVIDER_KEY,
        modelVersion: PROVIDER_KEY,
        candidates: [
          {
            index: 0,
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [
                { thought: true, text: PROVIDER_KEY, thoughtSignature: PROVIDER_KEY },
                { thoughtSignature: PROVIDER_KEY },
                { text: '{"move":', thought: false, partMetadata: { secret: PROVIDER_KEY } },
                { text: '"e7e5"}' },
              ],
            },
            citationMetadata: { secret: PROVIDER_KEY },
          },
        ],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 30,
          cachedContentTokenCount: 5,
          totalTokenCount: 90,
          secret: PROVIDER_KEY,
        },
      }),
    ]);
    const result = await createGoogleAdapter(http.transport).requestMove(
      contractInput(googleFixture),
    );
    expect(result).toMatchObject({
      ok: true,
      output: { move: "e7e5" },
      providerRequestId: null,
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 90 },
    });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
  });

  it("does not synthesize totals or output counts from thought/cache usage", async () => {
    const http = mockHttp([
      Response.json({
        ...googleResponse(),
        usageMetadata: { promptTokenCount: 50, thoughtsTokenCount: 30, cachedContentTokenCount: 5 },
      }),
    ]);
    expect(
      await createGoogleAdapter(http.transport).requestMove(contractInput(googleFixture)),
    ).toMatchObject({
      ok: true,
      usage: { inputTokens: 50, outputTokens: null, totalTokens: null },
    });
  });

  it.each([
    ["MAX_TOKENS", { code: "model_invalid", reason: "truncated_output" }],
    ...[
      "SAFETY",
      "RECITATION",
      "LANGUAGE",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_SAFETY",
      "IMAGE_PROHIBITED_CONTENT",
      "IMAGE_RECITATION",
      "ESCALATION",
    ].map((reason) => [reason, { code: "model_invalid", reason: "refusal" }]),
    ...["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"].map((reason) => [
      reason,
      { code: "model_invalid", reason: "malformed_output" },
    ]),
    ...[
      "OTHER",
      "FINISH_REASON_UNSPECIFIED",
      "IMAGE_OTHER",
      "NO_IMAGE",
      "TOO_MANY_TOOL_CALLS",
      "MISSING_THOUGHT_SIGNATURE",
      "invented",
    ].map((reason) => [reason, invalidResponse]),
  ])("honors finish reason %s even with valid JSON", async (finishReason, error) => {
    const response = googleResponse(undefined, googleFixture.reportedUsage);
    const http = mockHttp([
      Response.json({ ...response, candidates: [{ ...response.candidates[0], finishReason }] }),
    ]);
    expect(
      await createGoogleAdapter(http.transport).requestMove(contractInput(googleFixture)),
    ).toMatchObject({ ok: false, error, usage: googleFixture.reportedUsage });
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it.each(["SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"])(
    "classifies blocked prompts without candidates: %s",
    async (blockReason) => {
      const http = mockHttp([
        Response.json({
          candidates: [],
          promptFeedback: { blockReason },
          usageMetadata: { promptTokenCount: 5 },
        }),
      ]);
      expect(
        await createGoogleAdapter(http.transport).requestMove(contractInput(googleFixture)),
      ).toMatchObject({
        ok: false,
        error: { code: "model_invalid", reason: "refusal" },
        usage: { inputTokens: 5, outputTokens: null, totalTokens: null },
      });
    },
  );

  it.each([
    { name: "missing candidates", response: {} },
    { name: "empty candidates", response: { candidates: [] } },
    { name: "empty candidate", response: { candidates: [{}] } },
    {
      name: "multiple candidates",
      response: {
        ...googleResponse(),
        candidates: [googleResponse().candidates[0], googleResponse().candidates[0]],
      },
    },
    {
      name: "blocked prompt with candidate",
      response: { ...googleResponse(), promptFeedback: { blockReason: "SAFETY" } },
    },
    {
      name: "unknown prompt block reason",
      response: { ...googleResponse(), promptFeedback: { blockReason: "invented" } },
    },
    ...[
      { name: "nonzero candidate index", candidate: { index: 1 } },
      { name: "null finish reason", candidate: { finishReason: null } },
      { name: "oversized finish reason", candidate: { finishReason: "x".repeat(129) } },
      { name: "user content role", candidate: { content: { role: "user", parts: [] } } },
      { name: "missing content parts", candidate: { content: { role: "model" } } },
      ...[
        { name: "non-string text", parts: [{ text: 1 }] },
        { name: "non-boolean thought flag", parts: [{ text: "", thought: "true" }] },
        { name: "function call part", parts: [{ functionCall: {} }] },
        { name: "inline data part", parts: [{ inlineData: {} }] },
        { name: "empty part", parts: [{}] },
        { name: "mixed text and function call", parts: [{ text: "", functionCall: {} }] },
        { name: "too many parts", parts: Array.from({ length: 129 }, () => ({ text: "" })) },
      ].map(({ name, parts }) => ({ name, candidate: { content: { role: "model", parts } } })),
    ].map(({ name, candidate }) => ({
      name,
      response: {
        ...googleResponse(),
        candidates: [{ ...googleResponse().candidates[0], ...candidate }],
      },
    })),
    ...[
      { name: "negative prompt tokens", usageMetadata: { promptTokenCount: -1 } },
      { name: "fractional candidate tokens", usageMetadata: { candidatesTokenCount: 1.5 } },
      { name: "non-numeric total tokens", usageMetadata: { totalTokenCount: "50" } },
      {
        name: "unsafe prompt token integer",
        usageMetadata: { promptTokenCount: Number.MAX_SAFE_INTEGER + 1 },
      },
      { name: "non-numeric thought tokens", usageMetadata: { thoughtsTokenCount: "invalid" } },
      { name: "negative cache tokens", usageMetadata: { cachedContentTokenCount: -1 } },
      { name: "non-object usage", usageMetadata: "unavailable" },
    ].map(({ name, usageMetadata }) => ({
      name,
      response: { ...googleResponse(), usageMetadata },
    })),
  ])("rejects malformed envelopes or usage: $name", async ({ response }) => {
    const http = mockHttp([Response.json(response)]);
    expect(
      await createGoogleAdapter(http.transport).requestMove(contractInput(googleFixture)),
    ).toMatchObject({ ok: false, error: invalidResponse });
  });
});

describe("Google transport", () => {
  it.each([
    [400, "INVALID_ARGUMENT", { code: "provider_unavailable", reason: "upstream" }],
    [400, "FAILED_PRECONDITION", { code: "provider_unavailable", reason: "upstream" }],
    [401, "UNAUTHENTICATED", { code: "provider_auth" }],
    [403, "PERMISSION_DENIED", { code: "provider_auth" }],
    [499, "CANCELLED", { code: "provider_unavailable", reason: "cancelled" }],
    [501, "UNIMPLEMENTED", { code: "provider_unavailable", reason: "unsupported_model" }],
    [200, "UNAVAILABLE", { code: "provider_unavailable", reason: "upstream" }],
  ] as const)("classifies HTTP %i/%s without prose or retries", async (status, code, error) => {
    const http = mockHttp([googleError(status, code)]);
    const result = await createGoogleAdapter(http.transport).requestMove(
      contractInput(googleFixture),
    );
    expect(result).toMatchObject({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 504, 503])("classifies non-JSON HTTP %i safely", async (status) => {
    const http = mockHttp([new Response(PROVIDER_KEY, { status })]);
    const result = await createGoogleAdapter(http.transport).listModels(
      contractInput(googleFixture),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code:
          status === 429
            ? "provider_quota"
            : status === 504
              ? "provider_timeout"
              : status === 503
                ? "provider_unavailable"
                : "provider_auth",
      },
    });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel a missing catalog endpoint as a missing model", async () => {
    const http = mockHttp([googleError(404, "NOT_FOUND")]);
    expect(
      await createGoogleAdapter(http.transport).listModels(contractInput(googleFixture)),
    ).toEqual({ ok: false, error: { code: "provider_unavailable", reason: "upstream" } });
  });
});
