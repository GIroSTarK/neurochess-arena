import { describe, expect, it } from "vitest";

import {
  aiGameConfigurationSchema,
  aiTurnCommandSchema,
  aiTurnRequestSchema,
  modelDiscoveryRequestSchema,
} from "./index.js";

const command = {
  gameId: "4096aa18-cec3-4fb5-bbb0-fb8ac82970ff",
  commandId: "978ecc09-1ae0-4d7b-b3f5-b0a35a3ad6da",
  expectedVersion: 0,
};

describe("session-only HTTP credential contracts", () => {
  it("keeps the credential outside the durable command", () => {
    expect(aiTurnRequestSchema.parse({ ...command, apiKey: "key-sentinel" })).toMatchObject(
      command,
    );
    expect(aiTurnCommandSchema.safeParse({ ...command, apiKey: "key-sentinel" }).success).toBe(
      false,
    );
  });
  it.each(["", " ", "line\nbreak", "key\n", "nul\0key", "a".repeat(4097)])(
    "rejects malformed keys",
    (apiKey) => {
      expect(modelDiscoveryRequestSchema.safeParse({ provider: "openai", apiKey }).success).toBe(
        false,
      );
    },
  );
  it.each(["prompt", "fen", "legalMoves", "provider", "parameters", "credentialId"])(
    "rejects client-controlled %s in a turn",
    (field) => {
      expect(
        aiTurnRequestSchema.safeParse({ ...command, apiKey: "key-sentinel", [field]: "injected" })
          .success,
      ).toBe(false);
    },
  );
  it("rejects credentials in persisted configuration", () => {
    const seat = { type: "ai", provider: "openai", modelId: "dynamic-model", parameters: {} };
    const config = { mode: "ai_vs_ai", seats: { white: seat, black: seat } };
    expect(aiGameConfigurationSchema.safeParse({ ...config, apiKey: "key-sentinel" }).success).toBe(
      false,
    );
    expect(
      aiGameConfigurationSchema.safeParse({
        ...config,
        seats: { ...config.seats, white: { ...seat, apiKey: "key-sentinel" } },
      }).success,
    ).toBe(false);
  });
});
