import { z } from "zod";

import { aiProviderSchema, modelIdSchema } from "./provider.js";

const rate = z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,6})?(?![\s\S])/);
export const pricingRatesSchema = z.strictObject({
  inputTokens: rate,
  cachedInputTokens: rate,
  outputTokens: rate,
  cacheWrite5mTokens: rate.optional(),
  cacheWrite1hTokens: rate.optional(),
  reasoningTokens: rate.optional(),
});

export const pricingSnapshotSchema = z
  .strictObject({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d{1,4}(?![\s\S])/),
    provider: aiProviderSchema,
    modelId: modelIdSchema,
    checkedAt: z.iso.date(),
    source: z.enum([
      "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
      "https://developers.openai.com/api/docs/models/gpt-5-mini",
      "https://platform.claude.com/docs/en/about-claude/pricing",
      "https://ai.google.dev/gemini-api/docs/pricing",
    ]),
    currency: z.literal("USD"),
    unit: z.literal("usd_per_million_tokens"),
    basis: z.literal("standard_list_price"),
    rates: pricingRatesSchema,
  })
  .refine(({ provider, rates }) => {
    if (provider === "anthropic") {
      return (
        rates.cacheWrite5mTokens !== undefined &&
        rates.cacheWrite1hTokens !== undefined &&
        rates.reasoningTokens === undefined
      );
    }
    if (rates.cacheWrite5mTokens !== undefined || rates.cacheWrite1hTokens !== undefined) {
      return false;
    }
    if (provider === "google") return rates.reasoningTokens !== undefined;
    return provider === "openai" && rates.reasoningTokens === undefined;
  });

export const costUnavailableReasonSchema = z.enum([
  "legacy_record",
  "dispatch_unknown",
  "model_price_unknown",
  "routing_price_unknown",
  "usage_missing",
  "usage_incomplete",
  "usage_invalid",
  "model_unknown",
  "tier_unknown",
  "unsupported_dimensions",
  "pricing_invalid",
]);

export const costEstimateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("estimated"),
    amount: z.string().regex(/^(0|[1-9]\d{0,25})\.\d{12}(?![\s\S])/),
    currency: z.literal("USD"),
    pricing: pricingSnapshotSchema,
  }),
  z.strictObject({ status: z.literal("unavailable"), reason: costUnavailableReasonSchema }),
]);

export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
export type CostEstimate = z.infer<typeof costEstimateSchema>;
export type CostUnavailableReason = z.infer<typeof costUnavailableReasonSchema>;
