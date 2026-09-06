import { describe, expect, it } from "vitest";

import { aiTurnCommandSchema, createAiGameRequestSchema } from "./index.js";

const ai = { provider: "openai", modelId: "fixture-model", parameters: { temperature: 0 } };
const creation = { mode: "ai_vs_ai", white: ai, black: ai };
const turn = {
  gameId: "10000000-0000-4000-8000-000000000001",
  commandId: "20000000-0000-4000-8000-000000000002",
  expectedVersion: 0,
};

describe("guest AI game contracts", () => {
  it("accepts independent AI seats and either human color", () => {
    expect(createAiGameRequestSchema.parse(creation)).toEqual(creation);
    for (const humanColor of ["white", "black"]) {
      const request = { mode: "ai_vs_human", humanColor, ai };
      expect(createAiGameRequestSchema.parse(request)).toEqual(request);
    }
    expect(aiTurnCommandSchema.parse(turn)).toEqual(turn);
  });

  it.each([
    { ...creation, mode: "human_vs_human" },
    { ...creation, white: undefined },
    { ...creation, ownerGuestSessionId: turn.gameId },
    { ...creation, isSandbox: true },
    { ...creation, fen: "client-position" },
    { ...creation, white: { ...ai, apiKey: "forbidden-key" } },
    { ...creation, white: { ...ai, parameters: { prompt: "custom" } } },
    { mode: "ai_vs_human", humanColor: "both", ai },
    { mode: "ai_vs_human", humanColor: "white", ai, black: ai },
  ])("rejects invalid composition, credentials, and client authority (%j)", (input) => {
    expect(createAiGameRequestSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { ...turn, expectedVersion: -1 },
    { ...turn, expectedVersion: 0.5 },
    { ...turn, commandId: "bad-id" },
    { ...turn, move: "e2e4" },
    { ...turn, color: "white" },
    { ...turn, configuration: ai },
    { ...turn, context: {} },
    { ...turn, apiKey: "forbidden-key" },
    { ...turn, executorId: turn.commandId },
    { ...turn, leaseMs: 1000 },
  ])("accepts only retry identity and expected revision for a turn (%j)", (input) => {
    expect(aiTurnCommandSchema.safeParse(input).success).toBe(false);
  });
});
