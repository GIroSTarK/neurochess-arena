import type { NormalizedMoveResponse } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { createOperations } from "../../src/monitoring/operations.js";
import type { MoveRequest } from "../../src/providers/adapter.js";
import { invokeMove } from "../../src/providers/invoke-move.js";
import { access, output } from "../ai-turn-helpers.js";

import { createScriptedAdapter } from "./scripted-adapter.js";

const request: MoveRequest = {
  ...access(),
  instructions: "fixture",
  modelId: "fixture",
  parameters: {},
  context: { fen: "fixture", pgn: "*", color: "white", turn: "white", legalMoves: ["e2e4"] },
};

describe("safe move invocation boundary", () => {
  it.each([
    { name: "absent commentary", commentary: undefined, expected: { move: "e2e4" } },
    { name: "empty commentary", commentary: "", expected: { move: "e2e4", commentary: "" } },
    {
      name: "safe commentary",
      commentary: "Controls the center.",
      expected: { move: "e2e4", commentary: "Controls the center." },
    },
    {
      name: "credential echo",
      commentary: `echo ${request.apiKey} in viewer text`,
      expected: { move: "e2e4" },
    },
    { name: "NUL", commentary: "unsafe\0text", expected: { move: "e2e4" } },
  ])("independently sanitizes adapter commentary: $name", async ({ commentary, expected }) => {
    const usage = { inputTokens: 0, outputTokens: null, totalTokens: null };
    const billing = { status: "unavailable", reason: "usage_missing" } as const;
    const response = {
      ...output("e2e4", commentary),
      usage,
      billing,
      providerRequestId: "upstream-id",
    };
    const adapter = createScriptedAdapter({ provider: "openai", moves: [async () => response] });

    const result = await invokeMove(adapter, request);

    expect(result).toMatchObject({ ok: true, usage, billing, providerRequestId: null });
    if (!result.ok) throw new Error("Expected a valid move");
    expect(result.output).toEqual(expected);
    expect(response).toEqual({
      ...output("e2e4", commentary),
      usage,
      billing,
      providerRequestId: "upstream-id",
    });
  });

  it("preserves safe commentary when the request key is empty", async () => {
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [async () => output("e2e4", "Controls the center.")],
    });
    expect(await invokeMove(adapter, { ...request, apiKey: "" })).toMatchObject({
      ok: true,
      output: { move: "e2e4", commentary: "Controls the center." },
    });
  });

  it("keeps an unsupported model selection outside infrastructure-failure alerts", async () => {
    const operations = createOperations();
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [
        async () => ({
          ok: false,
          error: { code: "provider_unavailable", reason: "unsupported_model" },
          usage: null,
          durationMs: 0,
          providerRequestId: null,
        }),
      ],
    });
    expect(await invokeMove(adapter, request, operations)).toMatchObject({
      ok: false,
      error: { reason: "unsupported_model" },
    });
    expect(operations.snapshot().counters).toMatchObject({
      providerUnavailable: 0,
      providerUnsupported: 1,
    });
  });
  it("counts timeouts separately from invalid output and cancellation without retaining provider content", async () => {
    const operations = createOperations();
    const timeout = new AbortController();
    timeout.abort(new DOMException("private-timeout-canary", "TimeoutError"));
    await invokeMove(
      createScriptedAdapter({ provider: "openai" }),
      { ...request, signal: timeout.signal },
      operations,
    );
    const invalid = createScriptedAdapter({
      provider: "openai",
      moves: [
        async () => ({
          ok: false,
          error: { code: "model_invalid", reason: "malformed_output" },
          durationMs: 0,
          usage: null,
          providerRequestId: null,
        }),
      ],
    });
    await invokeMove(invalid, request, operations);
    const cancelled = new AbortController();
    cancelled.abort("private-cancel-canary");
    await invokeMove(invalid, { ...request, signal: cancelled.signal }, operations);
    expect(operations.snapshot().counters).toMatchObject({
      providerCalls: 3,
      providerTimeouts: 1,
      modelInvalid: 1,
      providerCancelled: 1,
      providerUnavailable: 0,
    });
    expect(JSON.stringify(operations.snapshot())).not.toContain("canary");
    const broken = {
      ...operations,
      increment() {
        throw new Error("private-sink-canary");
      },
    };
    expect(
      await invokeMove(
        createScriptedAdapter({ provider: "openai", moves: [async () => output("e2e4")] }),
        request,
        broken,
      ),
    ).toMatchObject({ ok: true, output: { move: "e2e4" } });
  });
  it.each([
    {
      name: "missing move",
      response: { ...output("e2e4"), output: { commentary: "not persisted" } },
      error: { code: "model_invalid", reason: "malformed_output" },
    },
    {
      name: "SAN move",
      response: { ...output("e2e4"), output: { move: "e4" } },
      error: { code: "model_invalid", reason: "malformed_output" },
    },
    {
      name: "non-numeric usage",
      response: { ...output("e2e4"), usage: { totalTokens: "unknown" } },
      error: { code: "provider_unavailable", reason: "invalid_response" },
    },
    {
      name: "extra credential field",
      response: { ...output("e2e4"), apiKey: "secret" },
      error: { code: "provider_unavailable", reason: "invalid_response" },
    },
    {
      name: "extra error message",
      response: { ok: false, error: { code: "provider_auth", message: "secret" } },
      error: { code: "provider_unavailable", reason: "invalid_response" },
    },
  ])("classifies invalid adapter output: $name", async ({ response, error }) => {
    const adapter = {
      ...createScriptedAdapter({ provider: "openai" }),
      requestMove: async () => response as NormalizedMoveResponse,
    };
    const result = await invokeMove(adapter, request);
    expect(result).toMatchObject({ ok: false, error, usage: null });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("not persisted");
  });

  it("drops secret-bearing exceptions and preserves no cause, response or provider request ID", async () => {
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [
        () => {
          throw new Error(request.apiKey, { cause: { apiKey: request.apiKey } });
        },
      ],
    });
    const result = await invokeMove(adapter, request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_unavailable", reason: "upstream" },
      usage: null,
      providerRequestId: null,
    });
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
  });

  it("normalizes an operational timeout without passing along the abort reason", async () => {
    const controller = new AbortController();
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [
        () => {
          controller.abort(new DOMException("timeout-secret-sentinel", "TimeoutError"));
          return Promise.withResolvers<never>().promise;
        },
      ],
    });
    const result = await invokeMove(adapter, { ...request, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: "provider_timeout" } });
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });
});
