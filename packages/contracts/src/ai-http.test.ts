import { describe, expect, it } from "vitest";

import {
  aiControllerRequestSchema,
  aiGameConfigurationSchema,
  aiTurnCommandSchema,
  aiTurnRequestSchema,
  modelDiscoveryRequestSchema,
} from "./index.js";

const command = {
  controllerId: "4096aa18-cec3-4fb5-bbb0-fb8ac82970ff",
  gameId: "4096aa18-cec3-4fb5-bbb0-fb8ac82970ff",
  commandId: "978ecc09-1ae0-4d7b-b3f5-b0a35a3ad6da",
  expectedVersion: 0,
};

describe("HTTP credential source contracts", () => {
  it("accepts exactly one session key or saved reference for discovery and turns", () => {
    const credentialId = "a442b196-0613-4ff6-bf86-49186f0bb2a4";
    for (const source of [{ apiKey: "key-sentinel" }, { credentialId }]) {
      expect(modelDiscoveryRequestSchema.parse({ provider: "openai", ...source })).toEqual({
        provider: "openai",
        ...source,
      });
      expect(aiTurnRequestSchema.parse({ ...command, ...source })).toEqual({
        ...command,
        ...source,
      });
    }
    for (const source of [
      {},
      { apiKey: "key-sentinel", credentialId },
      { credentialId: "invalid" },
      { credentialId: null },
      { credentialId, userId: "caller-owned" },
      { credentialId, apiKey: "" },
    ]) {
      expect(modelDiscoveryRequestSchema.safeParse({ provider: "openai", ...source }).success).toBe(
        false,
      );
      expect(aiTurnRequestSchema.safeParse({ ...command, ...source }).success).toBe(false);
    }
    expect(aiTurnCommandSchema.safeParse({ ...command, credentialId }).success).toBe(false);
    const seat = {
      type: "ai",
      provider: "openai",
      modelId: "dynamic-model",
      parameters: {},
      credentialId,
    };
    expect(
      aiGameConfigurationSchema.safeParse({ mode: "ai_vs_ai", seats: { white: seat, black: seat } })
        .success,
    ).toBe(false);
  });
  it("validates controller actions without accepting credentials or client-defined expiry", () => {
    const acquire = {
      gameId: command.gameId,
      controllerId: command.controllerId,
      expectedVersion: 0,
      action: "acquire",
    };
    expect(aiControllerRequestSchema.parse(acquire)).toEqual(acquire);
    for (const extra of [{ apiKey: "sentinel" }, { expiresAt: "2099-01-01" }, { takeover: true }]) {
      expect(aiControllerRequestSchema.safeParse({ ...acquire, ...extra }).success).toBe(false);
    }
    expect(
      aiTurnRequestSchema.safeParse({ ...command, controllerId: undefined, apiKey: "sentinel" })
        .success,
    ).toBe(false);
    expect(
      aiTurnRequestSchema.safeParse({ ...command, step: "true", apiKey: "sentinel" }).success,
    ).toBe(false);
  });
  it("keeps the credential outside the durable command", () => {
    expect(aiTurnRequestSchema.parse({ ...command, apiKey: "key-sentinel" })).toMatchObject(
      command,
    );
    expect(aiTurnCommandSchema.safeParse({ ...command, apiKey: "key-sentinel" }).success).toBe(
      false,
    );
  });
  it.each([
    { name: "empty string", apiKey: "" },
    { name: "whitespace", apiKey: " " },
    { name: "embedded newline", apiKey: "line\nbreak" },
    { name: "trailing newline", apiKey: "key\n" },
    { name: "NUL character", apiKey: "nul\0key" },
    { name: "oversized key", apiKey: "a".repeat(4097) },
  ])("rejects malformed key: $name", ({ apiKey }) => {
    expect(modelDiscoveryRequestSchema.safeParse({ provider: "openai", apiKey }).success).toBe(
      false,
    );
  });
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
