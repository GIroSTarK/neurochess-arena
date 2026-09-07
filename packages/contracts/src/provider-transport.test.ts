import { describe, expect, it } from "vitest";

import {
  aiConfigurationSchema,
  aiTurnCommandSchema,
  aiTurnRequestSchema,
  createAiGameRequestSchema,
  modelDiscoveryRequestSchema,
  modelDiscoveryResponseSchema,
  modelDiscoveryResultSchema,
  sessionCredentialSchema,
} from "./index.js";

const credential = { provider: "openai", apiKey: "test-only-credential" };
const command = {
  gameId: "10000000-0000-4000-8000-000000000001",
  commandId: "20000000-0000-4000-8000-000000000002",
  expectedVersion: 0,
};

describe("session-only provider transport", () => {
  it("accepts catalog references only in discovery transport and game-creation selections", () => {
    const catalogId = command.commandId;
    expect(modelDiscoveryRequestSchema.parse({ credential, catalogId })).toEqual({
      credential,
      catalogId,
    });
    const response = { ok: true, value: [], catalogId };
    expect(modelDiscoveryResponseSchema.parse(response)).toEqual(response);
    expect(modelDiscoveryResultSchema.safeParse(response).success).toBe(false);
    const ai = { provider: "openai", modelId: "fixture", parameters: {}, catalogId };
    const creation = { mode: "ai_vs_ai", white: ai, black: { ...ai, catalogId: command.gameId } };
    expect(createAiGameRequestSchema.parse(creation)).toEqual(creation);
    expect(
      createAiGameRequestSchema.parse({ mode: "ai_vs_human", humanColor: "black", ai }),
    ).toEqual({ mode: "ai_vs_human", humanColor: "black", ai });
    expect(aiConfigurationSchema.safeParse(ai).success).toBe(false);
    expect(modelDiscoveryResponseSchema.safeParse({ ok: true, value: [] }).success).toBe(false);
    expect(
      modelDiscoveryRequestSchema.safeParse({ credential, catalogId: "raw-key-not-a-reference" })
        .success,
    ).toBe(false);
    expect(
      createAiGameRequestSchema.safeParse({
        ...creation,
        white: { ...ai, catalogId: "raw-key-not-a-reference" },
      }).success,
    ).toBe(false);
  });
  it("requires a separate credential only on discovery and AI-turn requests", () => {
    expect(modelDiscoveryRequestSchema.parse({ credential })).toEqual({ credential });
    expect(aiTurnRequestSchema.parse({ ...command, credential })).toEqual({
      ...command,
      credential,
    });
    expect(aiTurnRequestSchema.safeParse(command).success).toBe(false);
    expect(aiTurnCommandSchema.safeParse({ ...command, credential }).success).toBe(false);
    const ai = { provider: "openai", modelId: "fixture", parameters: {} };
    expect(
      createAiGameRequestSchema.safeParse({ mode: "ai_vs_ai", white: ai, black: ai, credential })
        .success,
    ).toBe(false);
  });

  it.each([
    undefined,
    null,
    "",
    " ",
    " padded",
    "line\nbreak",
    "line\rbreak",
    "tab\tkey",
    "é",
    "a".repeat(4097),
  ])("rejects missing, oversized, or unsafe credential text (case %#)", (apiKey) =>
    expect(sessionCredentialSchema.safeParse({ ...credential, apiKey }).success).toBe(false),
  );

  it("rejects credential maps, saved references, raw fields, and client capabilities", () => {
    for (const input of [
      {},
      { apiKey: credential.apiKey },
      { credential, white: credential },
      { credential: { ...credential, save: true } },
      { credential: { provider: "openai", credentialId: command.gameId } },
      { credential, capabilities: {} },
      { credential, guestSessionId: command.gameId },
    ]) {
      expect(modelDiscoveryRequestSchema.safeParse(input).success).toBe(false);
    }
    expect(
      modelDiscoveryResultSchema.safeParse({
        ok: false,
        error: { kind: "provider_auth", message: credential.apiKey },
      }).success,
    ).toBe(false);
  });
});
