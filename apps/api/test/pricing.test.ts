import type { BillingUsage } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { calculateCost, pinPricing } from "../src/pricing/calculator.js";

const openai = {
  status: "reported",
  provider: "openai",
  pricingMatch: "standard",
  dimensions: { inputTokens: 70, cachedInputTokens: 30, outputTokens: 40, reasoningTokens: 25 },
} satisfies BillingUsage;

describe("versioned exact list-price estimates", () => {
  it("uses exact decimal arithmetic without double billing nested reasoning", () => {
    expect(calculateCost(pinPricing("openai", "gpt-5-mini-2025-08-07"), openai)).toMatchObject({
      status: "estimated",
      amount: "0.000098250000",
      currency: "USD",
      pricing: {
        version: "2026-10-11.1",
        modelId: "gpt-5-mini-2025-08-07",
        unit: "usd_per_million_tokens",
      },
    });
    expect(calculateCost(pinPricing("openai", "gpt-4.1-mini-2025-04-14"), openai)).toMatchObject({
      status: "estimated",
      amount: "0.000095000000",
    });
  });

  it("prices both Anthropic write durations, reads, ordinary input and inclusive output", () => {
    expect(
      calculateCost(pinPricing("anthropic", "claude-sonnet-4-6"), {
        status: "reported",
        provider: "anthropic",
        pricingMatch: "standard",
        dimensions: {
          inputTokens: 10,
          cachedInputTokens: 30,
          cacheWrite5mTokens: 40,
          cacheWrite1hTokens: 30,
          outputTokens: 20,
        },
      }),
    ).toMatchObject({ status: "estimated", amount: "0.000669000000" });
  });

  it("prices Google visible output plus separate thinking once", () => {
    expect(
      calculateCost(pinPricing("google", "gemini-2.5-flash"), {
        status: "reported",
        provider: "google",
        pricingMatch: "standard",
        dimensions: {
          inputTokens: 60,
          cachedInputTokens: 40,
          outputTokens: 20,
          reasoningTokens: 50,
        },
      }),
    ).toMatchObject({ status: "estimated", amount: "0.000194200000" });
  });

  it("distinguishes explicit zero from missing required dimensions", () => {
    const price = pinPricing("openai", "gpt-5-mini-2025-08-07");
    const zero = {
      ...openai,
      dimensions: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    };
    expect(calculateCost(price, zero)).toMatchObject({
      status: "estimated",
      amount: "0.000000000000",
    });
    expect(
      calculateCost(price, {
        ...zero,
        dimensions: { ...zero.dimensions, cachedInputTokens: null },
      }),
    ).toEqual({ status: "unavailable", reason: "usage_incomplete" });
    expect(calculateCost(price, undefined)).toEqual({
      status: "unavailable",
      reason: "usage_missing",
    });
    expect(
      calculateCost(price, { ...zero, dimensions: { ...zero.dimensions, outputTokens: -1 } }),
    ).toEqual({ status: "unavailable", reason: "usage_invalid" });
  });

  it("rejects unknown aliases, routed prices, mismatched models and unsupported billing classes", () => {
    expect(calculateCost(pinPricing("openai", "gpt-5-mini"), openai)).toEqual({
      status: "unavailable",
      reason: "model_price_unknown",
    });
    expect(calculateCost(pinPricing("openrouter", "openai/gpt-5-mini"), openai)).toEqual({
      status: "unavailable",
      reason: "routing_price_unknown",
    });
    for (const pricingMatch of [
      "model_unknown",
      "tier_unknown",
      "unsupported_dimensions",
    ] as const) {
      expect(
        calculateCost(pinPricing("openai", "gpt-5-mini-2025-08-07"), { ...openai, pricingMatch }),
      ).toEqual({ status: "unavailable", reason: pricingMatch });
    }
  });

  it("pins independent price snapshots and preserves the old version after a catalogue change", () => {
    const old = pinPricing("openai", "gpt-5-mini-2025-08-07");
    if (old.status !== "available") throw new Error("Expected supported price");
    const changed = {
      ...old,
      pricing: {
        ...old.pricing,
        version: "2026-10-12.1",
        rates: { ...old.pricing.rates, outputTokens: "3" },
      },
    };
    expect(calculateCost(changed, openai)).toMatchObject({
      amount: "0.000138250000",
      pricing: { version: "2026-10-12.1" },
    });
    expect(calculateCost(old, openai)).toMatchObject({
      amount: "0.000098250000",
      pricing: { version: "2026-10-11.1" },
    });
    changed.pricing.rates.inputTokens = "9";
    expect(calculateCost(pinPricing("openai", "gpt-5-mini-2025-08-07"), openai)).toMatchObject({
      amount: "0.000098250000",
    });
  });

  it("retains pico-dollar precision and safe-integer token counts without binary rounding", () => {
    const price = pinPricing("openai", "gpt-5-mini-2025-08-07");
    if (price.status !== "available") throw new Error("Expected supported price");
    price.pricing.rates.cachedInputTokens = "0.000001";
    expect(
      calculateCost(price, {
        ...openai,
        dimensions: { inputTokens: 0, cachedInputTokens: 1, outputTokens: 0 },
      }),
    ).toMatchObject({ amount: "0.000000000001" });
    expect(
      calculateCost(price, {
        ...openai,
        dimensions: { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 0 },
      }),
    ).toMatchObject({ amount: "2251799813.685247750000" });
  });
});
