import { describe, expect, it } from "vitest";

import { aiTurnRecordSchema, modelInvocationSchema } from "./invocation.js";

const id = "00000000-0000-4000-8000-000000000001";
const accepted = {
  id,
  attemptNumber: 1,
  commandId: id,
  expectedVersion: 0,
  provider: "openai",
  modelId: "fixture",
  effectiveParameters: {},
  outcome: "accepted",
  error: null,
  durationMs: 12,
  usage: null,
  commentary: null,
  billing: null,
  cost: { status: "unavailable", reason: "legacy_record" },
};
const unknown = { ...accepted, outcome: "in_flight", durationMs: null };

describe("private normalized invocation contracts", () => {
  it("keeps absent, partially known and zero usage distinct", () => {
    for (const usage of [
      null,
      { inputTokens: null, outputTokens: null, totalTokens: null },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { inputTokens: 7, outputTokens: null, totalTokens: null },
    ]) {
      expect(modelInvocationSchema.parse({ ...accepted, usage }).usage).toEqual(usage);
    }
  });

  it("accepts pending/interrupted attempts with unknown measurements and discarded safe errors", () => {
    for (const attempt of [
      unknown,
      { ...unknown, outcome: "interrupted" },
      { ...accepted, outcome: "discarded", error: { code: "provider_quota" } },
    ]) {
      expect(modelInvocationSchema.parse(attempt)).toEqual(attempt);
    }
  });

  it("rejects secret-bearing fields, malformed usage and inconsistent outcome metadata", () => {
    for (const attempt of [
      { ...accepted, apiKey: "secret" },
      { ...accepted, prompt: "prompt" },
      { ...accepted, rawResponse: {} },
      { ...accepted, effectiveParameters: { apiKey: "secret" } },
      { ...accepted, provider: "mock" },
      { ...accepted, error: { code: "provider_auth", message: "secret" } },
      {
        ...accepted,
        outcome: "provider_error",
        error: { code: "model_invalid", reason: "illegal_move" },
      },
      { ...accepted, outcome: "model_invalid", error: { code: "provider_timeout" } },
      { ...accepted, outcome: "discarded", commentary: "unaccepted commentary" },
      { ...accepted, durationMs: null },
      { ...accepted, durationMs: -1 },
      { ...accepted, usage: { inputTokens: -1, outputTokens: null, totalTokens: null } },
      { ...accepted, attemptNumber: 0 },
      { ...accepted, expectedVersion: -1 },
      { ...unknown, usage: { inputTokens: 0, outputTokens: null, totalTokens: null } },
    ]) {
      expect(modelInvocationSchema.safeParse(attempt).success).toBe(false);
    }
  });

  it("checks logical-turn counters, attempt sequence and accepted move association", () => {
    const turn = {
      id,
      ply: 1,
      color: "white",
      invalidOutputCount: 0,
      acceptedMovePly: 1,
      attempts: [accepted],
    };
    expect(aiTurnRecordSchema.parse(turn)).toEqual(turn);
    for (const invalid of [
      { ...turn, invalidOutputCount: 1 },
      { ...turn, invalidOutputCount: 4 },
      { ...turn, acceptedMovePly: null },
      { ...turn, acceptedMovePly: 2 },
      { ...turn, color: "black" },
      { ...turn, attempts: [accepted, accepted] },
      { ...turn, attempts: [{ ...accepted, attemptNumber: 2 }] },
    ]) {
      expect(aiTurnRecordSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
