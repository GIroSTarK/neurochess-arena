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

  it.each([{}, { models: [] }, { models: [], nextPageToken: "" }])(
    "accepts empty protobuf catalogs: %j",
    async (catalog) => {
      const http = mockHttp([Response.json(catalog)]);
      expect(
        await createGoogleAdapter(http.transport).listModels(contractInput(googleFixture)),
      ).toEqual({ ok: true, models: [] });
    },
  );

  it.each([
    { models: {} },
    { models: null },
    { nextPageToken: "next" },
    googleCatalog(["duplicate", "duplicate"]),
    googleCatalog([PROVIDER_KEY]),
    ...[PROVIDER_KEY, "line\nbreak", "trailing\n", "x".repeat(2049), 1, null].map(
      (nextPageToken) => ({
        ...googleCatalog(),
        nextPageToken,
      }),
    ),
    ...[
      { name: "https://evil.example/model" },
      { name: "models/a/b" },
      { name: "models/../models" },
      { name: "models/a:generateContent" },
      { name: "models/a?key=value" },
      { name: "models/a%2fb" },
      { name: "models/bad\n" },
      { name: `models/${"x".repeat(257)}` },
      { displayName: PROVIDER_KEY },
      { displayName: "bad\0name" },
      { displayName: "trailing\n" },
      { displayName: "x".repeat(129) },
      { supportedGenerationMethods: "generateContent" },
      { supportedGenerationMethods: [1] },
      { supportedGenerationMethods: Array.from({ length: 129 }, () => "generateContent") },
      { outputTokenLimit: -1 },
      { outputTokenLimit: 0 },
      { outputTokenLimit: 1.5 },
      { outputTokenLimit: Number.MAX_SAFE_INTEGER + 1 },
      { maxTemperature: -1 },
      { maxTemperature: "2" },
    ].map((fields) => ({ models: [{ ...googleModel(), ...fields }] })),
  ])(
    "rejects malformed or credential-echoing catalogs before further dispatch: %j",
    async (catalog) => {
      const http = mockHttp([Response.json(catalog)]);
      const result = await createGoogleAdapter(http.transport).listModels(
        contractInput(googleFixture),
      );
      expect(result).toEqual({ ok: false, error: invalidResponse });
      expect(JSON.stringify({ result, urls: http.requests.map(({ url }) => url) })).not.toContain(
        PROVIDER_KEY,
      );
      expect(http.transport).toHaveBeenCalledTimes(1);
    },
  );

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

  it.each([undefined, unknownGoogleCapabilities])(
    "attempts unknown capabilities with no optional fields: %j",
    async (capabilities) => {
      const http = mockHttp([Response.json(googleResponse())]);
      const input = { ...contractInput(googleFixture), modelId: "future-text-model" };
      if (capabilities === undefined) delete input.capabilities;
      else input.capabilities = capabilities;
      expect(await createGoogleAdapter(http.transport).requestMove(input)).toMatchObject({
        ok: true,
      });
      expect(await http.requests[0]!.json()).not.toHaveProperty("generationConfig");
    },
  );

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
    { maxOutputTokens: 0 },
    { maxOutputTokens: 65_537 },
    { temperature: 2.1 },
    { temperature: -1 },
  ])("rejects invalid settings before dispatch: %j", async (parameters) => {
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
    "bad\nmodel",
    PROVIDER_KEY,
    "models/gemini-2.5-flash",
    "../models",
    "a/b",
    "a?key=value",
    "a:generateContent",
    "a%2fb",
  ])("rejects unsafe or noncanonical selected identifiers: %s", async (modelId) => {
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
    '{"move":"e5"}',
    '{"move":"e7e5","extra":true}',
    '{"move":"e7e5","commentary":null}',
    '```json\n{"move":"e7e5"}\n```',
    '{"move":',
    "",
    JSON.stringify({ move: "e7e5", commentary: "x".repeat(2001) }),
  ])("does not repair invalid model JSON: %s", async (text) => {
    const http = mockHttp([Response.json(googleResponse(text, googleFixture.reportedUsage))]);
    expect(
      await createGoogleAdapter(http.transport).requestMove(contractInput(googleFixture)),
    ).toMatchObject({
      ok: false,
      error: { code: "model_invalid", reason: "malformed_output" },
      usage: googleFixture.reportedUsage,
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
    {},
    { candidates: [] },
    { candidates: [{}] },
    {
      ...googleResponse(),
      candidates: [googleResponse().candidates[0], googleResponse().candidates[0]],
    },
    { ...googleResponse(), promptFeedback: { blockReason: "SAFETY" } },
    { ...googleResponse(), promptFeedback: { blockReason: "invented" } },
    ...[
      { index: 1 },
      { finishReason: null },
      { finishReason: "x".repeat(129) },
      { content: { role: "user", parts: [] } },
      { content: { role: "model" } },
      ...[
        [{ text: 1 }],
        [{ text: "", thought: "true" }],
        [{ functionCall: {} }],
        [{ inlineData: {} }],
        [{}],
        [{ text: "", functionCall: {} }],
        Array.from({ length: 129 }, () => ({ text: "" })),
      ].map((parts) => ({ content: { role: "model", parts } })),
    ].map((candidate) => ({
      ...googleResponse(),
      candidates: [{ ...googleResponse().candidates[0], ...candidate }],
    })),
    ...[
      { promptTokenCount: -1 },
      { candidatesTokenCount: 1.5 },
      { totalTokenCount: "50" },
      { promptTokenCount: Number.MAX_SAFE_INTEGER + 1 },
      { thoughtsTokenCount: "invalid" },
      { cachedContentTokenCount: -1 },
      "unavailable",
    ].map((usageMetadata) => ({ ...googleResponse(), usageMetadata })),
  ])("classifies malformed envelopes/usage as provider failures: %j", async (response) => {
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

  it.each(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])(
    "normalizes native fetch timeout %s",
    async (code) => {
      const http = mockHttp([new TypeError(PROVIDER_KEY, { cause: { code } })]);
      expect(
        await createGoogleAdapter(http.transport).requestMove(contractInput(googleFixture)),
      ).toMatchObject({ ok: false, error: { code: "provider_timeout" } });
    },
  );

  it("propagates cancellation while consuming a body", async () => {
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
              stream.enqueue(new TextEncoder().encode('{"candidates":'));
              entered.resolve();
            },
          }),
        ),
    ]);
    const pending = createGoogleAdapter(http.transport).requestMove({
      ...contractInput(googleFixture),
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
      await createGoogleAdapter(http.transport).requestMove(contractInput(googleFixture)),
    ).toMatchObject({ ok: false, error: { code: "provider_unavailable", reason: "network" } });
  });

  it.each(["not json", "x".repeat(4 * 1024 * 1024 + 1), new Uint8Array([0xff])])(
    "rejects non-JSON, oversized or invalid UTF-8 bodies",
    async (body) => {
      const http = mockHttp([new Response(body)]);
      expect(
        await createGoogleAdapter(http.transport).requestMove(contractInput(googleFixture)),
      ).toMatchObject({ ok: false, error: invalidResponse });
    },
  );
});
