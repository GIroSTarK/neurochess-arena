import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  aiConfigurationSchema,
  aiErrorSchema,
  aiMoveResponseSchema,
  aiParametersSchema,
  aiTelemetrySchema,
  modelContextSchema,
  modelDescriptorSchema,
  modelDiscoveryResultSchema,
  normalizedMoveResponseSchema,
  providerDescriptorSchema,
  providerErrorKindSchema,
  providerIdSchema,
  supportedParametersSchema,
  tokenUsageSchema,
} from "./index.js";

const configuration = { provider: "openai", modelId: "fixture/model-v1", parameters: {} };
const descriptor = {
  provider: "openai",
  id: "fixture/model-v1",
  name: "Fixture model",
  supportedParameters: {
    temperature: { min: 0, max: 2 },
    maxOutputTokens: { min: 1, max: 4096 },
    reasoningEffort: { values: ["low", "medium", "high"] },
  },
};
const context = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  pgn: '[Result "*"]\n\n*',
  color: "white",
  sideToMove: "white",
  legalMoves: ["e2e4", "g1f3"],
};
const telemetry = { latencyMs: 12.5, usage: null };

describe("AI descriptors and configuration", () => {
  it.each(providerIdSchema.options)("supports dynamic model descriptors for %s", (provider) => {
    expect(providerDescriptorSchema.parse({ id: provider, name: "Fixture provider" })).toEqual({
      id: provider,
      name: "Fixture provider",
    });
    expect(modelDescriptorSchema.parse({ ...descriptor, provider })).toEqual({
      ...descriptor,
      provider,
    });
    expect(aiConfigurationSchema.parse({ ...configuration, provider })).toEqual({
      ...configuration,
      provider,
    });
  });

  it("represents unsupported parameters by absence without inventing defaults", () => {
    expect(supportedParametersSchema.parse({})).toEqual({});
    expect(aiParametersSchema.parse({})).toEqual({});
    expect(aiParametersSchema.parse({ temperature: 0, reasoningEffort: "minimal" })).toEqual({
      temperature: 0,
      reasoningEffort: "minimal",
    });
  });

  it.each([
    { temperature: { min: 2, max: 1 } },
    { temperature: { min: -1, max: 1 } },
    { temperature: { min: 0, max: Infinity } },
    { temperature: { min: 0 } },
    { maxOutputTokens: { min: 0, max: 100 } },
    { maxOutputTokens: { min: 1, max: 0.5 } },
    { maxOutputTokens: { min: 100, max: 50 } },
    { maxOutputTokens: { min: 1, max: Number.MAX_SAFE_INTEGER + 1 } },
    { reasoningEffort: { values: [] } },
    { reasoningEffort: { values: ["high", "high"] } },
    { reasoningEffort: { values: ["high\n"] } },
    { topP: { min: 0, max: 1 } },
    { temperature: { min: 0, max: 2, apiKey: "canary" } },
  ])("rejects malformed or unbounded capability metadata: %j", (input) => {
    expect(supportedParametersSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { provider: "mock" },
    { modelId: "" },
    { modelId: "model\n" },
    { modelId: "a".repeat(201) },
    { parameters: { temperature: "0.5" } },
    { parameters: { temperature: NaN } },
    { parameters: { temperature: -1 } },
    { parameters: { maxOutputTokens: 0 } },
    { parameters: { maxOutputTokens: 1.5 } },
    { parameters: { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { parameters: { reasoningEffort: "" } },
    { parameters: { customPrompt: "untrusted" } },
    { parameters: { apiKey: "canary" } },
    { apiKey: "canary" },
    { credential: "canary" },
  ])("rejects malformed configuration and secret-bearing fields: %j", (fields) => {
    expect(aiConfigurationSchema.safeParse({ ...configuration, ...fields }).success).toBe(false);
  });

  it("rejects unknown descriptor fields and invalid identities", () => {
    expect(providerDescriptorSchema.safeParse({ id: "other", name: "Other" }).success).toBe(false);
    expect(modelDescriptorSchema.safeParse({ ...descriptor, name: " " }).success).toBe(false);
    expect(
      modelDescriptorSchema.safeParse({ ...descriptor, raw: { token: "canary" } }).success,
    ).toBe(false);
    expect(
      modelDescriptorSchema.safeParse({ ...descriptor, supportedParameters: undefined }).success,
    ).toBe(false);
  });
});

describe("model context and move schemas", () => {
  it("accepts only the common chess context", () => {
    expect(modelContextSchema.parse(context)).toEqual(context);
    for (const field of Object.keys(context)) {
      const incomplete: Record<string, unknown> = { ...context };
      delete incomplete[field];
      expect(modelContextSchema.safeParse(incomplete).success).toBe(false);
    }
    for (const field of [
      "opponentModel",
      "opponentProvider",
      "commentary",
      "stockfish",
      "apiKey",
      "instruction",
    ]) {
      expect(modelContextSchema.safeParse({ ...context, [field]: "untrusted" }).success).toBe(
        false,
      );
    }
    for (const fields of [
      { color: "black" },
      { sideToMove: "w" },
      { legalMoves: [] },
      { legalMoves: ["e4"] },
      { legalMoves: ["e2e4", "e2e4"] },
    ]) {
      expect(modelContextSchema.safeParse({ ...context, ...fields }).success).toBe(false);
    }
  });

  it.each(["e2e4", "e1g1", "e7e8q", "a7b8n", "h2h1r", "b2a1b"])(
    "accepts canonical UCI and optional commentary: %s",
    (move) => {
      expect(aiMoveResponseSchema.parse({ move })).toEqual({ move });
      expect(aiMoveResponseSchema.parse({ move, commentary: "Controls the center." })).toEqual({
        move,
        commentary: "Controls the center.",
      });
      expect(aiMoveResponseSchema.parse({ move, commentary: "" })).toEqual({
        move,
        commentary: "",
      });
    },
  );

  it.each([
    null,
    [],
    {},
    "e2e4",
    { move: null },
    { move: 12 },
    { move: "e4" },
    { move: "resign" },
    { move: "e2e4\n" },
    { move: "E2E4" },
    { move: "e2e2" },
    { move: "e7e8Q" },
    { move: "e2e4", commentary: null },
    { move: "e2e4", commentary: {} },
    { move: "e2e4", commentary: "x".repeat(2001) },
    { move: "e2e4", reasoning: "untrusted" },
  ])("rejects malformed move output: %j", (output) => {
    expect(aiMoveResponseSchema.safeParse(output).success).toBe(false);
  });
});

describe("usage, telemetry, and safe error contracts", () => {
  it("distinguishes known zero, partial reporting, and unavailable usage", () => {
    for (const usage of [
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { inputTokens: 30, outputTokens: null, totalTokens: null },
      { inputTokens: null, outputTokens: null, totalTokens: 42 },
    ]) {
      expect(tokenUsageSchema.parse(usage)).toEqual(usage);
    }
    expect(aiTelemetrySchema.parse(telemetry)).toEqual(telemetry);
  });

  it("requires safe integer counts and explicit nulls for unreported fields", () => {
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const field of Object.keys(usage)) {
      for (const invalid of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        "12",
        undefined,
      ]) {
        expect(tokenUsageSchema.safeParse({ ...usage, [field]: invalid }).success).toBe(false);
      }
    }
    expect(tokenUsageSchema.safeParse({ ...usage, raw: { apiKey: "canary" } }).success).toBe(false);
    for (const invalid of [-1, Infinity, "10"]) {
      expect(aiTelemetrySchema.safeParse({ ...telemetry, latencyMs: invalid }).success).toBe(false);
    }
    expect(
      aiTelemetrySchema.safeParse({
        ...telemetry,
        providerRequestId: "https://provider.test/?key=canary",
      }).success,
    ).toBe(false);
  });

  it("keeps model mistakes separate from provider failures and rejects raw errors", () => {
    const errors = [
      { kind: "model_invalid", reason: "malformed_output" },
      { kind: "model_invalid", reason: "illegal_move" },
      ...providerErrorKindSchema.options.map((kind) => ({ kind })),
    ];
    for (const error of errors) {
      expect(aiErrorSchema.parse(error)).toEqual(error);
      expect(normalizedMoveResponseSchema.parse({ ok: false, error, ...telemetry })).toEqual({
        ok: false,
        error,
        ...telemetry,
      });
      for (const field of ["message", "cause", "request", "headers", "apiKey", "raw"]) {
        expect(aiErrorSchema.safeParse({ ...error, [field]: "canary" }).success).toBe(false);
      }
    }
    expect(aiErrorSchema.safeParse({ kind: "provider_auth", reason: "illegal_move" }).success).toBe(
      false,
    );
    expect(aiErrorSchema.safeParse({ kind: "model_invalid" }).success).toBe(false);
    expect(modelDiscoveryResultSchema.safeParse({ ok: false, error: errors[0] }).success).toBe(
      false,
    );
  });

  it("validates discovery and normalized success without accepting raw payloads", () => {
    expect(modelDiscoveryResultSchema.parse({ ok: true, value: [descriptor] })).toEqual({
      ok: true,
      value: [descriptor],
    });
    expect(modelDiscoveryResultSchema.parse({ ok: true, value: [] })).toEqual({
      ok: true,
      value: [],
    });
    const result = { ok: true, value: { move: "e2e4", ...telemetry } };
    expect(normalizedMoveResponseSchema.parse(result)).toEqual(result);
    expect(normalizedMoveResponseSchema.safeParse({ ...result, raw: "canary" }).success).toBe(
      false,
    );
  });

  it("can represent every shared AI boundary as JSON Schema", () => {
    for (const schema of [
      providerDescriptorSchema,
      modelDescriptorSchema,
      aiConfigurationSchema,
      modelContextSchema,
      aiMoveResponseSchema,
      aiErrorSchema,
      tokenUsageSchema,
      normalizedMoveResponseSchema,
      modelDiscoveryResultSchema,
    ]) {
      expect(z.toJSONSchema(schema)).toHaveProperty("$schema");
    }
  });
});
