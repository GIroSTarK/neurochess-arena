import { describe, expect, it } from "vitest";

import {
  aiGameConfigurationSchema,
  aiProviderSchema,
  type AiSeat,
  aiTurnCommandSchema,
} from "./index.js";

const ai: AiSeat = { type: "ai", provider: "openai", modelId: "fixture-model", parameters: {} };
const human = { type: "human" } as const;
const configuration = { mode: "ai_vs_ai", seats: { white: ai, black: ai } };

describe("AI turn command boundary", () => {
  const command = {
    gameId: "00000000-0000-4000-8000-000000000001",
    commandId: "00000000-0000-4000-8000-000000000002",
    expectedVersion: 0,
  };

  it("accepts only the resource, revision and command identity", () => {
    expect(aiTurnCommandSchema.parse(command)).toEqual(command);
    for (const invalid of [
      {},
      { ...command, expectedVersion: -1 },
      { ...command, expectedVersion: 0.5 },
      { ...command, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...command, commandId: "not-a-uuid" },
      { ...command, gameId: "not-a-uuid" },
      ...[
        "fen",
        "pgn",
        "legalMoves",
        "context",
        "instructions",
        "opponent",
        "apiKey",
        "move",
        "color",
      ].map((field) => ({ ...command, [field]: "untrusted" })),
    ]) {
      expect(aiTurnCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("ordinary AI game configuration", () => {
  it("round trips independent seats, identical models, all providers and either human color", () => {
    for (const provider of aiProviderSchema.options) {
      const white = { ...ai, provider, parameters: { temperature: 0, maxOutputTokens: 500 } };
      const black = { ...ai, provider, parameters: { reasoningEffort: "fixture-effort" } };
      for (const input of [
        { mode: "ai_vs_ai", seats: { white, black } },
        { mode: "ai_vs_human", seats: { white: human, black } },
        { mode: "ai_vs_human", seats: { white, black: human } },
      ]) {
        expect(aiGameConfigurationSchema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
      }
    }
    const parsed = aiGameConfigurationSchema.parse(configuration);
    expect(parsed.seats.white).not.toBe(parsed.seats.black);
  });

  it.each([
    { name: "Sandbox mode", input: { ...configuration, mode: "sandbox" } },
    { name: "human-only mode", input: { ...configuration, mode: "human_vs_human" } },
    { name: "AI versus human with two AI seats", input: { ...configuration, mode: "ai_vs_human" } },
    {
      name: "AI versus AI with a human seat",
      input: { ...configuration, seats: { white: human, black: ai } },
    },
    {
      name: "AI versus human with two human seats",
      input: { mode: "ai_vs_human", seats: { white: human, black: human } },
    },
    { name: "missing black seat", input: { ...configuration, seats: { white: ai } } },
    { name: "array of seats", input: { ...configuration, seats: [ai, ai] } },
    { name: "extra seat", input: { ...configuration, seats: { white: ai, black: ai, red: ai } } },
  ])("rejects mismatched mode or seats: $name", ({ input }) => {
    expect(aiGameConfigurationSchema.safeParse(input).success).toBe(false);
  });

  it("rejects credentials, identity, sandbox privileges and domain context at every configuration level", () => {
    for (const field of [
      "apiKey",
      "credentialId",
      "ownerId",
      "guestSessionId",
      "isSandbox",
      "fen",
      "pgn",
      "prompt",
      "color",
    ]) {
      for (const input of [
        { ...configuration, [field]: "sentinel" },
        { ...configuration, seats: { ...configuration.seats, [field]: "sentinel" } },
        { ...configuration, seats: { white: { ...ai, [field]: "sentinel" }, black: ai } },
        {
          ...configuration,
          seats: { white: { ...ai, parameters: { [field]: "sentinel" } }, black: ai },
        },
        { mode: "ai_vs_human", seats: { white: { ...human, [field]: "sentinel" }, black: ai } },
      ]) {
        expect(aiGameConfigurationSchema.safeParse(input).success).toBe(false);
      }
    }
  });

  it.each([
    { name: "mock provider", patch: { provider: "mock" } },
    { name: "unknown provider", patch: { provider: "unknown" } },
    { name: "empty model ID", patch: { modelId: "" } },
    { name: "newline in model ID", patch: { modelId: "m\n" } },
    { name: "oversized model ID", patch: { modelId: "m".repeat(257) } },
    { name: "query in model ID", patch: { modelId: "model?key=sentinel" } },
    { name: "null parameters", patch: { parameters: null } },
    { name: "array parameters", patch: { parameters: [] } },
    { name: "negative temperature", patch: { parameters: { temperature: -1 } } },
    { name: "Infinity temperature", patch: { parameters: { temperature: Infinity } } },
    { name: "string temperature", patch: { parameters: { temperature: "0.5" } } },
    { name: "empty reasoning effort", patch: { parameters: { reasoningEffort: "" } } },
    {
      name: "oversized reasoning effort",
      patch: { parameters: { reasoningEffort: "r".repeat(65) } },
    },
    { name: "zero output tokens", patch: { parameters: { maxOutputTokens: 0 } } },
    { name: "fractional output tokens", patch: { parameters: { maxOutputTokens: 1.5 } } },
    {
      name: "unsafe output token integer",
      patch: { parameters: { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    },
    { name: "nested parameters", patch: { parameters: { nested: { temperature: 1 } } } },
  ])("rejects malformed selection: $name", ({ patch }) => {
    expect(
      aiGameConfigurationSchema.safeParse({
        ...configuration,
        seats: { white: { ...ai, ...patch }, black: ai },
      }).success,
    ).toBe(false);
  });
});
