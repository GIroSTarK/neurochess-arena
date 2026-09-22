import type { NormalizedMoveResponse } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

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
