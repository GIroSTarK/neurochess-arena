import { createGame } from "@neurochess/chess";
import type { NormalizedMoveResponse } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { AI_MOVE_INSTRUCTIONS, type MoveRequest } from "../../src/providers/adapter.js";

import { createScriptedAdapter } from "./scripted-adapter.js";

function input(): MoveRequest {
  const game = createGame();
  game.start();
  const { fen, pgn, turn, legalMoves } = game.snapshot();
  return {
    instructions: AI_MOVE_INSTRUCTIONS,
    apiKey: "fixture-only",
    signal: new AbortController().signal,
    modelId: "fixture-model",
    parameters: {},
    context: { fen, pgn, turn, color: turn, legalMoves },
  };
}
const accepted: NormalizedMoveResponse = {
  ok: true,
  output: { move: "e2e4" },
  usage: null,
  durationMs: 10,
  providerRequestId: null,
};

describe("dependency-injected scripted provider fixture", () => {
  it("scripts discovery and move outcomes independently, with no retries or fallback", async () => {
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [
        { ok: true, models: [] },
        { ok: false, error: { code: "provider_auth" } },
      ],
      moves: [
        accepted,
        {
          ok: false,
          error: { code: "provider_quota" },
          usage: null,
          durationMs: 1,
          providerRequestId: null,
        },
      ],
    });
    expect(await adapter.listModels(input())).toEqual({ ok: true, models: [] });
    expect(await adapter.listModels(input())).toEqual({
      ok: false,
      error: { code: "provider_auth" },
    });
    const result = await adapter.requestMove(input());
    expect(result).toEqual(accepted);
    if (result.ok) result.output.move = "d2d4";
    expect(accepted.output.move).toBe("e2e4");
    expect(adapter.discoveryCalls).toBe(2);
    expect(adapter.moveCalls).toBe(1);
    expect(await adapter.requestMove(input())).toMatchObject({
      ok: false,
      error: { code: "provider_quota" },
    });
    expect(adapter.moveCalls).toBe(2);
    await expect(adapter.requestMove(input())).rejects.toThrow("Scripted adapter exhausted");
    await expect(adapter.listModels(input())).rejects.toThrow("Scripted adapter exhausted");
  });

  it("allows a test to hold a request and inspect cancellation without retaining its credentials", async () => {
    let release!: (result: NormalizedMoveResponse) => void;
    const controller = new AbortController();
    const adapter = createScriptedAdapter({
      provider: "anthropic",
      moves: [
        async (request) => {
          expect(request.signal).toBe(controller.signal);
          expect(Object.keys(request.context).sort()).toEqual([
            "color",
            "fen",
            "legalMoves",
            "pgn",
            "turn",
          ]);
          return new Promise<NormalizedMoveResponse>((resolve) => {
            release = resolve;
          });
        },
      ],
    });
    const pending = adapter.requestMove({ ...input(), signal: controller.signal });
    expect(adapter.moveCalls).toBe(1);
    controller.abort();
    release(accepted);
    expect(await pending).toEqual(accepted);
    expect(JSON.stringify(adapter)).not.toContain("fixture-only");
    await expect(adapter.requestMove(input())).rejects.toThrow("Scripted adapter exhausted");
  });
});
