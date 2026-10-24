import { createGame } from "@neurochess/chess";
import {
  type AiParameters,
  type AiProvider,
  type ModelCapabilities,
  modelDiscoveryResultSchema,
  normalizedMoveResponseSchema,
  type ProviderFailure,
  type TokenUsage,
} from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import {
  AI_MOVE_INSTRUCTIONS,
  type AiProviderAdapter,
  type MoveRequest,
} from "../../src/providers/adapter.js";

import { type HttpStep, mockHttp } from "./mock-http.js";

export const PROVIDER_KEY = "contract-key-sentinel";
export const failureCases = {
  malformed_output: { code: "model_invalid", reason: "malformed_output" },
  refusal: { code: "model_invalid", reason: "refusal" },
  truncated_output: { code: "model_invalid", reason: "truncated_output" },
  unsupported_model: { code: "provider_unavailable", reason: "unsupported_model" },
  authentication: { code: "provider_auth" },
  quota: { code: "provider_quota" },
  rate_limit: { code: "provider_quota" },
  upstream: { code: "provider_unavailable", reason: "upstream" },
  malformed_envelope: { code: "provider_unavailable", reason: "invalid_response" },
  malformed_usage: { code: "provider_unavailable", reason: "invalid_response" },
  timeout: { code: "provider_timeout" },
} as const satisfies Record<string, ProviderFailure>;

export interface AdapterContractFixture {
  readonly provider: AiProvider;
  readonly modelId: string;
  readonly parameters: AiParameters;
  readonly capabilities: ModelCapabilities;
  readonly reportedUsage: TokenUsage;
  readonly createAdapter: (transport: typeof fetch) => AiProviderAdapter;
  readonly credential: (request: Request) => string | null;
  // Arrays let paginated providers exercise their entire discovery boundary.
  readonly catalog: (ids: string[]) => HttpStep[];
  readonly completion: (text: string, usage?: TokenUsage | null) => Response;
  readonly failure: (scenario: keyof typeof failureCases) => HttpStep;
  readonly readMove: (
    request: Request,
  ) => Promise<Pick<MoveRequest, "modelId" | "instructions" | "parameters" | "context">>;
}

export function contractInput(
  fixture: Pick<AdapterContractFixture, "modelId" | "parameters" | "capabilities">,
): MoveRequest {
  const game = createGame();
  game.start();
  game.playMove("e2e4");
  const { fen, pgn, turn, legalMoves } = game.snapshot();
  return {
    apiKey: PROVIDER_KEY,
    signal: new AbortController().signal,
    instructions: AI_MOVE_INSTRUCTIONS,
    modelId: fixture.modelId,
    parameters: fixture.parameters,
    capabilities: fixture.capabilities,
    context: { fen, pgn, turn, color: turn, legalMoves },
  };
}

export function runAdapterContract(fixture: AdapterContractFixture) {
  describe(`${fixture.provider} shared adapter contract through HTTP`, () => {
    it("discovers the live catalog, keeps unknown IDs, and normalizes bounded capabilities", async () => {
      const http = mockHttp(fixture.catalog([fixture.modelId, "future-text-model"]));
      const adapter = fixture.createAdapter(http.transport);
      const result = modelDiscoveryResultSchema.parse(
        await adapter.listModels(contractInput(fixture)),
      );
      expect(result).toEqual({
        ok: true,
        models: [
          {
            provider: fixture.provider,
            id: fixture.modelId,
            name: fixture.modelId,
            capabilities: fixture.capabilities,
          },
          {
            provider: fixture.provider,
            id: "future-text-model",
            name: "future-text-model",
            capabilities: {
              moveGeneration: "unknown",
              parameters: { temperature: null, reasoningEffort: null, maxOutputTokens: null },
            },
          },
        ],
      });
      expect(http.requests.length).toBe(
        fixture.catalog([fixture.modelId, "future-text-model"]).length,
      );
      expect(http.requests.every((request) => !request.url.includes(PROVIDER_KEY))).toBe(true);
    });

    it("handles empty catalogs and does not reuse another credential's discovery", async () => {
      const http = mockHttp([...fixture.catalog([fixture.modelId]), ...fixture.catalog([])]);
      const adapter = fixture.createAdapter(http.transport);
      await adapter.listModels(contractInput(fixture));
      expect(
        await adapter.listModels({ ...contractInput(fixture), apiKey: "different-key" }),
      ).toEqual({ ok: true, models: [] });
      expect(http.transport).toHaveBeenCalledTimes(
        fixture.catalog([fixture.modelId]).length + fixture.catalog([]).length,
      );
      expect(fixture.credential(http.requests.at(-1)!)).toContain("different-key");
    });

    it.each(["authentication", "quota", "rate_limit", "upstream", "timeout"] as const)(
      "classifies discovery %s without retries or upstream prose",
      async (scenario) => {
        const http = mockHttp([fixture.failure(scenario)]);
        const result = modelDiscoveryResultSchema.parse(
          await fixture.createAdapter(http.transport).listModels(contractInput(fixture)),
        );
        expect(result).toEqual({ ok: false, error: failureCases[scenario] });
        expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
        expect(http.transport).toHaveBeenCalledTimes(1);
      },
    );

    it("rejects an upstream move envelope where a catalog is required", async () => {
      const http = mockHttp([fixture.completion('{"move":"e7e5"}')]);
      expect(
        await fixture.createAdapter(http.transport).listModels(contractInput(fixture)),
      ).toEqual({ ok: false, error: { code: "provider_unavailable", reason: "invalid_response" } });
      expect(http.transport).toHaveBeenCalledTimes(1);
    });

    it.each([
      { name: "absent commentary", commentary: undefined },
      { name: "present commentary", commentary: "Develops a central pawn." },
    ])("accepts a legal UCI move: $name", async ({ commentary }) => {
      const output = { move: "e7e5", ...(commentary === undefined ? {} : { commentary }) };
      const usage = fixture.reportedUsage;
      const http = mockHttp([fixture.completion(JSON.stringify(output), usage)]);
      const input = contractInput(fixture);
      const result = normalizedMoveResponseSchema.parse(
        await fixture.createAdapter(http.transport).requestMove(input),
      );
      expect(result).toMatchObject({ ok: true, output, usage, providerRequestId: null });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(input.context.legalMoves).toContain(output.move);
      expect(await fixture.readMove(http.requests[0]!)).toEqual({
        instructions: input.instructions,
        context: input.context,
        modelId: input.modelId,
        parameters: input.parameters,
      });
      expect(http.requests[0]!.url).not.toContain(PROVIDER_KEY);
      expect(http.transport).toHaveBeenCalledTimes(1);
    });

    describe.each([
      { name: "valid move", text: '{"move":"e7e5"}', outcome: { ok: true } },
      {
        name: "malformed output",
        text: '{"move":',
        outcome: { ok: false, error: { code: "model_invalid", reason: "malformed_output" } },
      },
    ])("usage on $name", ({ text, outcome }) => {
      it.each([
        { name: "undefined usage", usage: undefined },
        { name: "null usage", usage: null },
        {
          name: "reported zero input tokens",
          usage: { inputTokens: 0, outputTokens: null, totalTokens: null },
        },
        {
          name: "all token counts null",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        },
      ])("preserves usage: $name", async ({ usage }) => {
        const http = mockHttp([fixture.completion(text, usage)]);
        expect(
          await fixture.createAdapter(http.transport).requestMove(contractInput(fixture)),
        ).toMatchObject({
          ...outcome,
          usage: usage ?? null,
        });
      });
    });

    it.each(Object.entries(failureCases))(
      "classifies %s without implicit retries or raw errors",
      async (name, error) => {
        const http = mockHttp([fixture.failure(name as keyof typeof failureCases)]);
        const result = normalizedMoveResponseSchema.parse(
          await fixture.createAdapter(http.transport).requestMove(contractInput(fixture)),
        );
        expect(result).toMatchObject({ ok: false, error, providerRequestId: null });
        expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
        expect(http.transport).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      { name: "null JSON", text: "null" },
      { name: "array JSON", text: '[{"move":"e7e5"}]' },
      { name: "SAN move", text: '{"move":"e5"}' },
      { name: "extra field", text: '{"move":"e7e5","extra":true}' },
      { name: "null commentary", text: '{"move":"e7e5","commentary":null}' },
      { name: "Markdown fence", text: '```json\n{"move":"e7e5"}\n```' },
      { name: "incomplete JSON", text: '{"move":' },
      { name: "empty text", text: "" },
      {
        name: "unsafe commentary with an extra field",
        text: JSON.stringify({ move: "e7e5", commentary: PROVIDER_KEY, extra: true }),
      },
      {
        name: "oversized commentary",
        text: JSON.stringify({ move: "e7e5", commentary: "x".repeat(2001) }),
      },
    ])("rejects malformed model JSON: $name", async ({ text }) => {
      const usage = fixture.reportedUsage;
      const http = mockHttp([fixture.completion(text, usage)]);
      const result = await fixture
        .createAdapter(http.transport)
        .requestMove(contractInput(fixture));
      expect(result).toMatchObject({
        ok: false,
        error: { code: "model_invalid", reason: "malformed_output" },
        usage,
        providerRequestId: null,
      });
      expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
      expect(http.transport).toHaveBeenCalledTimes(1);
    });

    it.each(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])(
      "classifies native fetch timeout %s without preserving its cause",
      async (code) => {
        const http = mockHttp([
          new TypeError(PROVIDER_KEY, { cause: { code, message: PROVIDER_KEY } }),
        ]);
        const result = await fixture
          .createAdapter(http.transport)
          .requestMove(contractInput(fixture));
        expect(result).toMatchObject({ ok: false, error: { code: "provider_timeout" } });
        expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
        expect(http.transport).toHaveBeenCalledTimes(1);
      },
    );

    it("propagates cancellation while consuming the response body", async ({ onTestFinished }) => {
      const controller = new AbortController();
      const reading = Promise.withResolvers<void>();
      const envelope = await fixture.completion('{"move":"e7e5"}').text();
      let bodyController: ReadableStreamDefaultController<Uint8Array>;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          bodyController = stream;
        },
        pull(stream) {
          if (!sent) {
            stream.enqueue(new TextEncoder().encode(envelope.slice(0, -1)));
            sent = true;
          } else {
            // A second pull proves the adapter consumed the first chunk and is awaiting more.
            reading.resolve();
          }
        },
      });
      const interrupt = () => bodyController.error(new Error(PROVIDER_KEY));
      const http = mockHttp([
        (request) => {
          request.signal.addEventListener("abort", interrupt, { once: true });
          return new Response(body);
        },
      ]);
      const pending = fixture.createAdapter(http.transport).requestMove({
        ...contractInput(fixture),
        signal: controller.signal,
      });
      onTestFinished(async () => {
        controller.abort();
        http.requests[0]?.signal.removeEventListener("abort", interrupt);
        interrupt();
        await pending;
      });
      await reading.promise;
      expect(body.locked).toBe(true);
      controller.abort(PROVIDER_KEY);
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        error: { code: "provider_unavailable", reason: "cancelled" },
      });
      expect(http.requests[0]!.signal.aborted).toBe(true);
      expect(body.locked).toBe(false);
      expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
      expect(http.transport).toHaveBeenCalledTimes(1);
    });

    it("classifies an interrupted body as a network failure", async () => {
      const body = new ReadableStream({
        start(stream) {
          stream.error(new TypeError(PROVIDER_KEY));
        },
      });
      const http = mockHttp([new Response(body)]);
      const result = await fixture
        .createAdapter(http.transport)
        .requestMove(contractInput(fixture));
      expect(result).toMatchObject({
        ok: false,
        error: { code: "provider_unavailable", reason: "network" },
      });
      expect(body.locked).toBe(false);
      expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
      expect(http.transport).toHaveBeenCalledTimes(1);
    });

    it("accepts a response at the exact 4 MiB byte limit across chunks", async () => {
      const output = { move: "e7e5", commentary: "Хід ♟" };
      const envelope = await fixture
        .completion(JSON.stringify(output), fixture.reportedUsage)
        .text();
      const bytes = new Uint8Array(4 * 1024 * 1024).fill(0x20);
      bytes.set(new TextEncoder().encode(envelope));
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(bytes.subarray(0, bytes.length - 1));
          stream.enqueue(bytes.subarray(bytes.length - 1));
          stream.close();
        },
      });
      const http = mockHttp([new Response(body)]);
      const result = await fixture
        .createAdapter(http.transport)
        .requestMove(contractInput(fixture));
      expect(result).toMatchObject({ ok: true, output, usage: fixture.reportedUsage });
      expect(body.locked).toBe(false);
      expect(http.transport).toHaveBeenCalledTimes(1);
    });

    it.each([1, 2, 3])("decodes a UTF-8 character split after byte %s", async (splitAfter) => {
      const output = { move: "e7e5", commentary: "Central pawn 😀" };
      const envelope = await fixture.completion(JSON.stringify(output)).text();
      const bytes = new TextEncoder().encode(envelope);
      const split = bytes.indexOf(0xf0) + splitAfter;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(bytes.subarray(0, split));
          stream.enqueue(bytes.subarray(split));
          stream.close();
        },
      });
      const http = mockHttp([new Response(body)]);
      const result = await fixture
        .createAdapter(http.transport)
        .requestMove(contractInput(fixture));
      expect(result).toMatchObject({ ok: true, output });
      expect(body.locked).toBe(false);
      expect(http.transport).toHaveBeenCalledTimes(1);
    });

    it.each([
      { name: "invalid JSON", body: () => "not json" },
      {
        name: "oversized body",
        body: async () => {
          const envelope = await fixture.completion('{"move":"e7e5"}').text();
          // Valid JSON ensures the size limit, rather than JSON parsing, rejects this body.
          return envelope.padEnd(4 * 1024 * 1024 + 1, " ");
        },
      },
      {
        name: "invalid UTF-8",
        body: async () => {
          const envelope = await fixture.completion('{"move":"e7e5","commentary":"#"}').text();
          const bytes = new TextEncoder().encode(envelope);
          // Replacement decoding would yield a valid move with commentary and pass JSON parsing.
          bytes[bytes.indexOf(0x23)] = 0xff;
          return bytes;
        },
      },
    ])("rejects response body: $name", async ({ body }) => {
      const response = new Response(await body());
      const http = mockHttp([response]);
      const result = await fixture
        .createAdapter(http.transport)
        .requestMove(contractInput(fixture));
      expect(result).toMatchObject({
        ok: false,
        error: { code: "provider_unavailable", reason: "invalid_response" },
      });
      expect(response.body!.locked).toBe(false);
      expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
      expect(http.transport).toHaveBeenCalledTimes(1);
    });

    it.each(["discovery", "move"] as const)(
      "sanitizes network failures during %s",
      async (operation) => {
        const http = mockHttp([
          Object.assign(new TypeError(PROVIDER_KEY), { request: { authorization: PROVIDER_KEY } }),
        ]);
        const adapter = fixture.createAdapter(http.transport);
        const result = await (operation === "move"
          ? adapter.requestMove(contractInput(fixture))
          : adapter.listModels(contractInput(fixture)));
        expect(result).toMatchObject({
          ok: false,
          error: { code: "provider_unavailable", reason: "network" },
        });
        expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
        expect(http.transport).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["discovery", "move"] as const)(
      "propagates cancellation and deadlines during %s",
      async (operation) => {
        for (const timeout of [false, true]) {
          const controller = new AbortController();
          const entered = Promise.withResolvers<void>();
          const http = mockHttp([
            (request) =>
              new Promise<Response>((_resolve, reject) => {
                request.signal.addEventListener("abort", () => reject(new Error(PROVIDER_KEY)), {
                  once: true,
                });
                entered.resolve();
              }),
          ]);
          const adapter = fixture.createAdapter(http.transport);
          const input = { ...contractInput(fixture), signal: controller.signal };
          const pending =
            operation === "move" ? adapter.requestMove(input) : adapter.listModels(input);
          await entered.promise;
          controller.abort(
            timeout ? new DOMException(PROVIDER_KEY, "TimeoutError") : new Error(PROVIDER_KEY),
          );
          const result = await pending;
          expect(http.requests[0]!.signal.aborted).toBe(true);
          expect(result).toMatchObject({
            ok: false,
            error: timeout
              ? { code: "provider_timeout" }
              : { code: "provider_unavailable", reason: "cancelled" },
          });
          expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
          expect(http.transport).toHaveBeenCalledTimes(1);
        }
      },
    );

    it("does not dispatch with an already-cancelled signal", async () => {
      const http = mockHttp([]);
      const input = { ...contractInput(fixture), signal: AbortSignal.abort(PROVIDER_KEY) };
      const adapter = fixture.createAdapter(http.transport);
      expect(await adapter.listModels(input)).toMatchObject({ ok: false });
      expect(await adapter.requestMove(input)).toMatchObject({ ok: false });
      expect(http.transport).not.toHaveBeenCalled();
    });

    it.each([
      { name: "credential echo", commentary: `echo ${PROVIDER_KEY} in viewer text` },
      { name: "NUL character", commentary: "unsafe\0text" },
    ])("omits unsafe optional commentary: $name", async ({ commentary }) => {
      const http = mockHttp([
        fixture.completion(JSON.stringify({ move: "e7e5", commentary }), fixture.reportedUsage),
      ]);
      const result = await fixture
        .createAdapter(http.transport)
        .requestMove(contractInput(fixture));
      expect(result).toMatchObject({
        ok: true,
        output: { move: "e7e5" },
        usage: fixture.reportedUsage,
        providerRequestId: null,
      });
      if (result.ok) expect(result.output).not.toHaveProperty("commentary");
    });
  });
}
