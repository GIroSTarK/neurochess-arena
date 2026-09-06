import { type ChessGame, createGame, type DomainResult, restoreGame } from "@neurochess/chess";
import {
  type AiConfiguration,
  type AiTelemetry,
  type ModelDescriptor,
  normalizedMoveResponseSchema,
  providerErrorKindSchema,
  type ProviderId,
  providerIdSchema,
} from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { GameRequestError } from "../games/errors.js";

import type { AiProviderAdapter } from "./adapter.js";
import { buildModelContext, MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { createScriptedMockProvider, type MockMoveStep } from "./mock.js";
import { normalizeMoveResponse, resolveAiConfiguration } from "./normalization.js";

const apiKey = "test-only-key-canary";
const model: ModelDescriptor = {
  provider: "openai",
  id: "fixture-model",
  name: "Fixture model",
  supportedParameters: {
    temperature: { min: 0, max: 2 },
    reasoningEffort: { values: ["low", "high"] },
    maxOutputTokens: { min: 16, max: 4096 },
  },
};
const configuration: AiConfiguration = {
  provider: model.provider,
  modelId: model.id,
  parameters: {},
};
const telemetry: AiTelemetry = {
  latencyMs: 125.5,
  usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
  providerRequestId: "fixture-request-1",
};

function unwrap<T>(result: DomainResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function activeGame(moves: readonly string[] = []): ChessGame {
  const game = createGame();
  unwrap(game.start());
  for (const move of moves) unwrap(game.playMove(move));
  return game;
}

function mock(moves: readonly MockMoveStep[], provider: ProviderId = "openai") {
  return createScriptedMockProvider({
    descriptor: { id: provider, name: "Fixture provider" },
    models: [{ ...model, provider }],
    moves,
  });
}

describe("canonical model context", () => {
  it("derives the initial and subsequent contexts without mutating authoritative state", () => {
    const game = activeGame();
    const initial = game.snapshot();
    expect(buildModelContext(game, "white")).toEqual({
      fen: initial.fen,
      pgn: initial.pgn,
      color: "white",
      sideToMove: "white",
      legalMoves: initial.legalMoves,
    });
    unwrap(game.playMove("e2e4"));
    const snapshot = game.snapshot();
    const context = buildModelContext(game, "black");
    expect(context).toEqual({
      fen: snapshot.fen,
      pgn: snapshot.pgn,
      color: "black",
      sideToMove: "black",
      legalMoves: snapshot.legalMoves,
    });
    expect(context.pgn).toContain("1. e4 *");
    expect(context.legalMoves).toContain("e7e5");
    context.legalMoves.splice(0);
    context.pgn = "changed";
    expect(game.snapshot()).toEqual(snapshot);
    expect(buildModelContext(game, "black").legalMoves).toEqual(snapshot.legalMoves);
  });

  it("projects only chess fields even if a caller enriches snapshots with private metadata", () => {
    const game = activeGame(["e2e4", "a7a6", "e4e5", "d7d5"]);
    const enriched: ChessGame = {
      ...game,
      snapshot: () => ({
        ...game.snapshot(),
        opponentProvider: "opponent-provider-canary",
        opponentModel: "opponent-model-canary",
        commentary: "opponent-commentary-canary",
        stockfish: { evaluation: 900, principalVariation: ["stockfish-canary"] },
        apiKey,
      }),
    };
    const context = buildModelContext(enriched, "white");
    expect(context).toEqual(buildModelContext(game, "white"));
    expect(context.legalMoves).toContain("e5d6");
    expect(context.pgn).toContain("1. e4 a6 2. e5 d5 *");
    expect(JSON.stringify(context)).not.toContain("canary");
    expect(context.pgn).not.toMatch(/\[(White|Black) "(?!\?")|\{|\[%eval/);
  });

  it("rejects inactive games and the wrong color without resuming or changing the game", () => {
    const configuring = createGame();
    const paused = activeGame();
    unwrap(paused.pause());
    const aborted = activeGame();
    unwrap(aborted.abort());
    const completed = activeGame(["f2f3", "e7e5", "g2g4", "d8h4"]);
    for (const game of [configuring, paused, aborted, completed]) {
      const before = game.snapshot();
      expect(() => buildModelContext(game, before.turn)).toThrow(GameRequestError);
      expect(game.snapshot()).toEqual(before);
    }
    const game = activeGame();
    expect(() => buildModelContext(game, "black")).toThrow("INVALID_GAME_STATE");
  });

  it("preserves full contexts and instructions across providers after restoration", async () => {
    const history = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1", "f8c5"];
    const live = activeGame(history);
    const expected = buildModelContext(live, "white");
    const recorded = [];
    for (const provider of providerIdSchema.options) {
      const restored = unwrap(
        restoreGame({
          moves: history,
          lifecycle: { state: "active", result: "*", terminationReason: null },
        }),
      );
      const adapter = mock([{ output: { move: "d2d3" } }], provider);
      const boundary: AiProviderAdapter = adapter;
      const result = await boundary.requestMove({
        apiKey,
        configuration: { ...configuration, provider },
        context: buildModelContext(restored, "white"),
      });
      expect(result.ok).toBe(true);
      expect(adapter.requests[0]?.context).toEqual(expected);
      expect(adapter.requests[0]?.instruction).toBe(MODEL_RESPONSE_INSTRUCTION);
      expect(restored.snapshot()).toEqual(live.snapshot());
      recorded.push(adapter.requests[0]?.context);
    }
    expect(new Set(recorded.map((context) => JSON.stringify(context))).size).toBe(1);
    expect(expected.pgn).toContain("1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O Bc5 *");
    expect(expected.legalMoves).toEqual(live.snapshot().legalMoves);
  });
});

describe("capability-aware configuration", () => {
  it("filters unsupported parameters, preserves explicit zero, and leaves inputs unchanged", () => {
    const requested: AiConfiguration = {
      ...configuration,
      parameters: { temperature: 0, reasoningEffort: "high", maxOutputTokens: 100 },
    };
    const limited = { ...model, supportedParameters: { temperature: { min: 0, max: 1 } } };
    expect(resolveAiConfiguration(requested, limited)).toEqual({
      ...configuration,
      parameters: { temperature: 0 },
    });
    expect(resolveAiConfiguration(requested, model)).toEqual(requested);
    expect(resolveAiConfiguration(configuration, model)).toEqual(configuration);
    expect(requested.parameters).toEqual({
      temperature: 0,
      reasoningEffort: "high",
      maxOutputTokens: 100,
    });
  });

  it("rejects mismatched models and unsupported values of supported parameters", () => {
    for (const parameters of [
      { temperature: 2.01 },
      { maxOutputTokens: 15 },
      { maxOutputTokens: 4097 },
      { reasoningEffort: "medium" },
      { temperature: NaN },
    ]) {
      expect(resolveAiConfiguration({ ...configuration, parameters }, model)).toBeNull();
    }
    expect(resolveAiConfiguration({ ...configuration, provider: "google" }, model)).toBeNull();
    expect(
      resolveAiConfiguration({ ...configuration, modelId: "another-model" }, model),
    ).toBeNull();
  });
});

describe("scripted provider boundary", () => {
  it("discovers configured models and consumes exactly one scripted response per request", async () => {
    const game = activeGame();
    const adapter = mock([
      { output: '{"move":"e2e4","commentary":"Controls the center."}', telemetry },
      { output: { move: "e7e5" } },
    ]);
    const discovery = await adapter.listModels({ apiKey });
    expect(discovery).toEqual({ ok: true, value: [model] });
    if (!discovery.ok) throw new Error("Unexpected discovery failure");
    discovery.value[0]!.name = "changed";
    expect(await adapter.listModels({ apiKey })).toEqual({ ok: true, value: [model] });
    const result = await adapter.requestMove({
      apiKey,
      configuration,
      context: buildModelContext(game, "white"),
    });
    expect(result).toEqual({
      ok: true,
      value: { move: "e2e4", commentary: "Controls the center.", ...telemetry },
    });
    expect(normalizedMoveResponseSchema.parse(result)).toEqual(result);
    expect(game.snapshot().moves).toHaveLength(0);
    if (!result.ok) throw new Error("Unexpected move failure");
    unwrap(game.playMove(result.value.move));
    const secondRequest = { apiKey, configuration, context: buildModelContext(game, "black") };
    expect(await adapter.requestMove(secondRequest)).toEqual({
      ok: true,
      value: { move: "e7e5", latencyMs: 0, usage: null },
    });
    expect(adapter.requests).toHaveLength(2);
    await expect(adapter.requestMove(secondRequest)).rejects.toThrow("MOCK_SCRIPT_EXHAUSTED");
  });

  it.each([
    undefined,
    null,
    12,
    [],
    {},
    "not JSON",
    "{",
    '```json\n{"move":"e2e4"}\n```',
    '"e2e4"',
    '{"move":"e2e4"} trailing',
    { move: "e4" },
    { move: "resign" },
    { move: "e2e4\n" },
    { move: "e2e4", commentary: null },
    { move: "e2e4", raw: { apiKey } },
  ])(
    "classifies malformed output without leaking payloads or applying moves: %j",
    async (output) => {
      const game = activeGame();
      const before = game.snapshot();
      const adapter = mock([{ output, telemetry }]);
      const result = await adapter.requestMove({
        apiKey,
        configuration,
        context: buildModelContext(game, "white"),
      });
      expect(result).toEqual({
        ok: false,
        error: { kind: "model_invalid", reason: "malformed_output" },
        ...telemetry,
      });
      expect(normalizedMoveResponseSchema.parse(result)).toEqual(result);
      expect(JSON.stringify(result)).not.toContain(apiKey);
      expect(game.snapshot()).toEqual(before);
      expect(adapter.requests).toHaveLength(1);
    },
  );

  it.each(["e2e5", "e2e4q", "e7e5"])(
    "rejects syntactically valid but illegal output %s",
    async (move) => {
      const game = activeGame();
      const adapter = mock([{ output: { move } }]);
      expect(
        await adapter.requestMove({
          apiKey,
          configuration,
          context: buildModelContext(game, "white"),
        }),
      ).toEqual({
        ok: false,
        error: { kind: "model_invalid", reason: "illegal_move" },
        latencyMs: 0,
        usage: null,
      });
      expect(game.snapshot().moves).toHaveLength(0);
    },
  );

  it.each(providerErrorKindSchema.options)(
    "preserves %s as a provider failure for discovery and moves",
    async (kind) => {
      const adapter = createScriptedMockProvider({
        descriptor: { id: "openai", name: "Fixture provider" },
        models: [model],
        discoveryError: { kind },
        moves: [{ error: { kind }, telemetry }, { output: { move: "e2e4" } }],
      });
      expect(await adapter.listModels({ apiKey })).toEqual({ ok: false, error: { kind } });
      const game = activeGame();
      const request = { apiKey, configuration, context: buildModelContext(game, "white") };
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind },
        ...telemetry,
      });
      expect(adapter.requests).toHaveLength(1);
      expect((await adapter.requestMove(request)).ok).toBe(true);
      expect(game.snapshot().state).toBe("active");
    },
  );

  it("captures defensive copies without retaining request credentials", async () => {
    const game = activeGame();
    const adapter = mock([{ output: { move: "e2e4" } }]);
    const context = buildModelContext(game, "white");
    const requested = { ...configuration, parameters: { temperature: 0 } };
    await adapter.requestMove({
      apiKey,
      configuration: requested,
      context,
      signal: new AbortController().signal,
    });
    requested.parameters.temperature = 1;
    context.legalMoves.splice(0);
    adapter.requests[0]!.context.legalMoves.splice(0);
    expect(adapter.requests[0]?.configuration.parameters).toEqual({ temperature: 0 });
    expect(adapter.requests[0]?.context).toEqual(buildModelContext(game, "white"));
    expect(Object.keys(adapter.requests[0]!)).toEqual(["configuration", "context", "instruction"]);
    expect(JSON.stringify(adapter)).not.toContain(apiKey);
  });

  it("rejects invalid requests without consuming a script step or retaining rejected inputs", async () => {
    const game = activeGame();
    const adapter = mock([{ output: { move: "e2e4" } }]);
    const request = { apiKey, configuration, context: buildModelContext(game, "white") };
    for (const invalid of [
      { ...configuration, provider: "google" },
      { ...configuration, parameters: { temperature: 3 } },
      { ...configuration, apiKey },
      null,
    ]) {
      await expect(
        adapter.requestMove({ ...request, configuration: invalid as AiConfiguration }),
      ).rejects.toThrow("INVALID_MOCK_REQUEST");
    }
    await expect(
      adapter.requestMove({ ...request, context: { ...request.context, sideToMove: "black" } }),
    ).rejects.toThrow("INVALID_MOCK_REQUEST");
    expect(adapter.requests).toEqual([]);
    expect((await adapter.requestMove(request)).ok).toBe(true);
  });

  it("rejects inconsistent mock model lists instead of inventing discovery data", () => {
    for (const models of [[model, model], [{ ...model, provider: "google" as const }]]) {
      expect(() =>
        createScriptedMockProvider({
          descriptor: { id: "openai", name: "Fixture provider" },
          models,
          moves: [],
        }),
      ).toThrow("INVALID_MOCK_SCRIPT");
    }
  });

  it("does not expose malformed telemetry validation details", () => {
    const unsafe = { ...telemetry, usage: { apiKey } };
    expect(() =>
      normalizeMoveResponse(
        { move: "e2e4" },
        buildModelContext(activeGame(), "white"),
        unsafe as unknown as AiTelemetry,
      ),
    ).toThrow("INVALID_PROVIDER_TELEMETRY");
  });
});
