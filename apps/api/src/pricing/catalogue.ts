import type { PricingSnapshot } from "@neurochess/contracts";

const common = {
  version: "2026-10-11.1",
  checkedAt: "2026-10-11",
  currency: "USD",
  unit: "usd_per_million_tokens",
  basis: "standard_list_price",
} as const;

// Assign a new version when prices or billing semantics change. Invocation rows
// hold a copy of the selected basis; reads never consult this current catalogue.
export const priceCatalogue: readonly PricingSnapshot[] = [
  {
    ...common,
    provider: "openai",
    modelId: "gpt-4.1-mini-2025-04-14",
    source: "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
    rates: { inputTokens: "0.40", cachedInputTokens: "0.10", outputTokens: "1.60" },
  },
  {
    ...common,
    provider: "openai",
    modelId: "gpt-5-mini-2025-08-07",
    source: "https://developers.openai.com/api/docs/models/gpt-5-mini",
    rates: { inputTokens: "0.25", cachedInputTokens: "0.025", outputTokens: "2" },
  },
  {
    ...common,
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    rates: {
      inputTokens: "3",
      cachedInputTokens: "0.30",
      cacheWrite5mTokens: "3.75",
      cacheWrite1hTokens: "6",
      outputTokens: "15",
    },
  },
  {
    ...common,
    provider: "google",
    modelId: "gemini-2.5-flash",
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    rates: {
      inputTokens: "0.30",
      cachedInputTokens: "0.03",
      outputTokens: "2.50",
      reasoningTokens: "2.50",
    },
  },
];
