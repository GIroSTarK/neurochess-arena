import { describe, expect, it } from "vitest";

import { modelInvocationSchema } from "./invocation.js";
import { pricingSnapshotSchema } from "./pricing.js";
import { normalizedMoveResponseSchema } from "./provider.js";

const price = {
  version: "2026-10-11.1",
  checkedAt: "2026-10-11",
  provider: "openai",
  modelId: "gpt-5-mini-2025-08-07",
  source: "https://developers.openai.com/api/docs/models/gpt-5-mini",
  currency: "USD",
  unit: "usd_per_million_tokens",
  basis: "standard_list_price",
  rates: { inputTokens: "0.25", cachedInputTokens: "0.025", outputTokens: "2" },
};

describe("cost transport integrity", () => {
  it("rejects insufficient/contradictory provider-specific rate bases and noncanonical decimals", () => {
    expect(pricingSnapshotSchema.safeParse(price).success).toBe(true);
    for (const invalid of [
      { ...price, provider: "anthropic" },
      { ...price, provider: "google" },
      { ...price, rates: { ...price.rates, outputTokens: "2\n" } },
      { ...price, rates: { ...price.rates, outputTokens: "2e-3" } },
      { ...price, rates: { ...price.rates, outputTokens: "0.0000001" } },
      { ...price, rates: { ...price.rates, outputTokens: -1 } },
      { ...price, source: "https://example.com/key" },
      { ...price, rates: { ...price.rates, raw: "secret" } },
    ]) {
      expect(pricingSnapshotSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("does not turn malformed optional billing into an invalid move response", () => {
    expect(
      normalizedMoveResponseSchema.parse({
        ok: true,
        output: { move: "e2e4" },
        durationMs: 1,
        usage: null,
        providerRequestId: null,
        billing: { status: "reported", rawKey: "secret" },
      }),
    ).toMatchObject({ ok: true, billing: { status: "unavailable", reason: "usage_invalid" } });
  });

  it("rejects estimated cost on uncertain attempts and mismatched invocation provenance", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const attempt = {
      id,
      commandId: id,
      expectedVersion: 0,
      attemptNumber: 1,
      provider: "openai",
      modelId: price.modelId,
      effectiveParameters: {},
      outcome: "accepted",
      error: null,
      durationMs: 1,
      usage: null,
      commentary: null,
      billing: null,
      cost: { status: "estimated", amount: "0.000000000000", currency: "USD", pricing: price },
    };
    expect(modelInvocationSchema.safeParse(attempt).success).toBe(true);
    expect(
      modelInvocationSchema.safeParse({ ...attempt, outcome: "interrupted", durationMs: null })
        .success,
    ).toBe(false);
    expect(
      modelInvocationSchema.safeParse({ ...attempt, modelId: "different-model" }).success,
    ).toBe(false);
    expect(modelInvocationSchema.safeParse({ ...attempt, provider: "google" }).success).toBe(false);
  });
});
