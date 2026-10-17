import { describe, expect, it } from "vitest";

import {
  aiMoveOutputSchema,
  modelCapabilitiesSchema,
  modelDescriptorSchema,
  modelDiscoveryResultSchema,
  modelIdSchema,
  normalizedMoveResponseSchema,
  providerFailureSchema,
  tokenUsageSchema,
} from "./index.js";

const unknownCapabilities = {
  moveGeneration: "unknown",
  parameters: { temperature: null, reasoningEffort: null, maxOutputTokens: null },
};

describe("normalized provider contracts", () => {
  it("preserves routed model aliases with a single leading tilde", () => {
    for (const id of ["~anthropic/claude-sonnet-latest", "~vendor/model:free"]) {
      const model = {
        provider: "openrouter",
        id,
        name: "Alias model",
        capabilities: unknownCapabilities,
      };
      expect(modelDiscoveryResultSchema.parse({ ok: true, models: [model] })).toEqual({
        ok: true,
        models: [model],
      });
    }
    expect(modelIdSchema.parse(`~${"x".repeat(255)}`)).toHaveLength(256);
  });

  it("rejects misplaced or repeated tilde prefixes and retains model ID bounds", () => {
    for (const id of [
      "~",
      "~~vendor/model",
      "vendor/~model",
      "vendor/model~",
      "~vendor/model?key=value",
      "~vendor/model\n",
      `~${"x".repeat(256)}`,
    ]) {
      expect(modelIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it("represents unknown support explicitly and bounds known capability metadata", () => {
    expect(modelCapabilitiesSchema.parse(unknownCapabilities)).toEqual(unknownCapabilities);
    expect(
      modelCapabilitiesSchema.safeParse({
        moveGeneration: "supported",
        parameters: {
          temperature: { min: 0, max: 2 },
          reasoningEffort: { values: ["low", "high"] },
          maxOutputTokens: { min: 1, max: 1000 },
        },
      }).success,
    ).toBe(true);
    for (const patch of [
      { temperature: true },
      { temperature: { min: 2, max: 0 } },
      { temperature: { min: 0, max: Infinity } },
      { reasoningEffort: { values: [] } },
      { reasoningEffort: { values: ["low", "low"] } },
      { reasoningEffort: { values: Array.from({ length: 33 }, (_, i) => `effort${i}`) } },
      { maxOutputTokens: { min: 1.5, max: 100 } },
      { maxOutputTokens: { min: 100, max: 1 } },
      { secret: "sentinel" },
    ]) {
      expect(
        modelCapabilitiesSchema.safeParse({
          ...unknownCapabilities,
          parameters: { ...unknownCapabilities.parameters, ...patch },
        }).success,
      ).toBe(false);
    }
  });

  it("allows dynamic routed identifiers and empty catalogs, rejecting duplicate or unbounded descriptors", () => {
    const model = {
      provider: "openrouter",
      id: "vendor/model-v1:variant",
      name: "Fixture model",
      capabilities: unknownCapabilities,
    };
    expect(modelDescriptorSchema.parse(model)).toEqual(model);
    expect(modelDiscoveryResultSchema.parse({ ok: true, models: [] })).toEqual({
      ok: true,
      models: [],
    });
    expect(modelDiscoveryResultSchema.safeParse({ ok: true, models: [model, model] }).success).toBe(
      false,
    );
    for (const patch of [{ name: "n".repeat(257) }, { provider: "mock" }, { apiKey: "sentinel" }]) {
      expect(modelDescriptorSchema.safeParse({ ...model, ...patch }).success).toBe(false);
    }
  });

  it("requires UCI, accepts missing commentary and leaves legality to the chess authority", () => {
    expect(aiMoveOutputSchema.parse({ move: "e2e4" })).toEqual({ move: "e2e4" });
    expect(
      aiMoveOutputSchema.parse({ move: "e2e4q", commentary: "<script>untrusted text</script>" })
        .move,
    ).toBe("e2e4q");
    for (const output of [
      {},
      { move: "e4" },
      { move: "resign" },
      { move: "e2e4\n" },
      { move: "e2e2" },
      { move: "e2e4", commentary: null },
      { move: "e2e4", commentary: "x".repeat(2001) },
      { move: "e2e4", analysis: "hidden" },
    ]) {
      expect(aiMoveOutputSchema.safeParse(output).success).toBe(false);
    }
  });

  it("keeps absent usage, partial reports and reported zero distinct without synthesizing totals", () => {
    const response = {
      ok: true,
      output: { move: "e2e4" },
      durationMs: 12,
      providerRequestId: null,
      usage: null,
    };
    for (const usage of [
      null,
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { inputTokens: 50, outputTokens: null, totalTokens: null },
    ]) {
      expect(normalizedMoveResponseSchema.parse({ ...response, usage }).usage).toEqual(usage);
    }
    for (const count of [-1, 0.5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        tokenUsageSchema.safeParse({ inputTokens: count, outputTokens: null, totalTokens: null })
          .success,
      ).toBe(false);
    }
    expect(tokenUsageSchema.safeParse({ inputTokens: 1 }).success).toBe(false);
    expect(normalizedMoveResponseSchema.safeParse({ ...response, durationMs: -1 }).success).toBe(
      false,
    );
    expect(
      normalizedMoveResponseSchema.safeParse({
        ...response,
        providerRequestId: "https://upstream/?key=sentinel",
      }).success,
    ).toBe(false);
  });

  it("returns only enumerated failures without raw exception or request details", () => {
    for (const error of [
      { code: "model_invalid", reason: "malformed_output" },
      { code: "model_invalid", reason: "refusal" },
      { code: "provider_auth" },
      { code: "provider_quota" },
      { code: "provider_timeout" },
      { code: "provider_unavailable", reason: "network" },
      { code: "provider_unavailable", reason: "unsupported_model" },
    ]) {
      expect(providerFailureSchema.parse(error)).toEqual(error);
      expect(
        normalizedMoveResponseSchema.safeParse({
          ok: false,
          error,
          usage: null,
          durationMs: 1,
          providerRequestId: null,
        }).success,
      ).toBe(true);
      for (const field of ["message", "stack", "request", "apiKey", "headers", "response"]) {
        expect(providerFailureSchema.safeParse({ ...error, [field]: "sentinel" }).success).toBe(
          false,
        );
      }
    }
    expect(providerFailureSchema.safeParse({ code: "sentinel" }).success).toBe(false);
    expect(
      providerFailureSchema.safeParse({ code: "provider_auth", reason: "illegal_move" }).success,
    ).toBe(false);
  });
});
