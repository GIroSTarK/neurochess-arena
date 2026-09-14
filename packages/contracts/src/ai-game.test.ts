import { describe, expect, it } from "vitest";

import { aiGameConfigurationSchema, aiProviderSchema, type AiSeat } from "./index.js";

const ai: AiSeat = { type: "ai", provider: "openai", modelId: "fixture-model", parameters: {} };
const human = { type: "human" } as const;
const configuration = { mode: "ai_vs_ai", seats: { white: ai, black: ai } };

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
    { ...configuration, mode: "sandbox" },
    { ...configuration, mode: "human_vs_human" },
    { ...configuration, mode: "ai_vs_human" },
    { ...configuration, seats: { white: human, black: ai } },
    { mode: "ai_vs_human", seats: { white: human, black: human } },
    { ...configuration, seats: { white: ai } },
    { ...configuration, seats: [ai, ai] },
    { ...configuration, seats: { white: ai, black: ai, red: ai } },
  ])("rejects mismatched modes and seat identities: %j", (input) => {
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
    { provider: "mock" },
    { provider: "unknown" },
    { modelId: "" },
    { modelId: "m\n" },
    { modelId: "m".repeat(257) },
    { modelId: "model?key=sentinel" },
    { parameters: null },
    { parameters: [] },
    { parameters: { temperature: -1 } },
    { parameters: { temperature: Infinity } },
    { parameters: { temperature: "0.5" } },
    { parameters: { reasoningEffort: "" } },
    { parameters: { reasoningEffort: "r".repeat(65) } },
    { parameters: { maxOutputTokens: 0 } },
    { parameters: { maxOutputTokens: 1.5 } },
    { parameters: { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { parameters: { nested: { temperature: 1 } } },
  ])("rejects malformed selection and parameter metadata: %j", (patch) => {
    expect(
      aiGameConfigurationSchema.safeParse({
        ...configuration,
        seats: { white: { ...ai, ...patch }, black: ai },
      }).success,
    ).toBe(false);
  });
});
