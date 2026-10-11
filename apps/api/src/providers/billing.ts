import type { AiProvider, BillingDimensions, BillingUsage } from "@neurochess/contracts";
import { z } from "zod";

const count = z.number().int().nonnegative().nullish();
const openAiUsage = z.strictObject({
  input_tokens: count,
  output_tokens: count,
  total_tokens: count,
  input_tokens_details: z.strictObject({ cached_tokens: count }).nullish(),
  output_tokens_details: z.strictObject({ reasoning_tokens: count }).nullish(),
});
const anthropicUsage = z.strictObject({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
  cache_creation: z
    .strictObject({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count })
    .nullish(),
  service_tier: z.string().max(32).nullish(),
  inference_geo: z.string().max(32).nullish(),
  server_tool_use: z.record(z.string().max(64), count).nullish(),
  output_tokens_details: z.unknown().optional(),
  speed: z.string().max(32).nullish(),
});
const modalityCounts = z
  .array(z.strictObject({ modality: z.string().max(32), tokenCount: count }))
  .max(16)
  .nullish();
const googleUsage = z.strictObject({
  promptTokenCount: count,
  candidatesTokenCount: count,
  totalTokenCount: count,
  cachedContentTokenCount: count,
  thoughtsTokenCount: count,
  toolUsePromptTokenCount: count,
  promptTokensDetails: modalityCounts,
  cacheTokensDetails: modalityCounts,
  candidatesTokensDetails: modalityCounts,
  toolUsePromptTokensDetails: modalityCounts,
  serviceTier: z.string().max(32).nullish(),
});
const routerUsage = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  total_tokens: count,
  prompt_tokens_details: z
    .object({ cached_tokens: count, cache_write_tokens: count, audio_tokens: count })
    .nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: count, audio_tokens: count }).nullish(),
});
const envelope = z.object({
  model: z.unknown().optional(),
  modelVersion: z.unknown().optional(),
  service_tier: z.unknown().optional(),
  usage: z.unknown().optional(),
  usageMetadata: z.unknown().optional(),
});

const missing: BillingUsage = { status: "unavailable", reason: "usage_missing" };
const invalid: BillingUsage = { status: "unavailable", reason: "usage_invalid" };

function difference(total: number | null | undefined, part: number | null | undefined) {
  return total == null || part == null ? null : total - part;
}

export function normalizeBilling(
  provider: AiProvider,
  modelId: string,
  raw: unknown,
): BillingUsage {
  const outer = envelope.safeParse(raw);
  if (!outer.success) return invalid;
  const response = outer.data;
  const rawUsage = provider === "google" ? response.usageMetadata : response.usage;
  if (rawUsage == null) return missing;
  const reported = (
    dimensions: BillingDimensions,
    pricingMatch: Extract<BillingUsage, { status: "reported" }>["pricingMatch"],
  ): BillingUsage => {
    if (
      Object.values(dimensions).some(
        (value) => value != null && (!Number.isSafeInteger(value) || value < 0),
      )
    ) {
      return invalid;
    }
    return { status: "reported", provider, pricingMatch, dimensions };
  };
  if (provider === "openai") {
    const parsed = openAiUsage.safeParse(rawUsage);
    if (!parsed.success) return invalid;
    const usage = parsed.data;
    const reasoning = usage.output_tokens_details?.reasoning_tokens ?? null;
    if (reasoning !== null && usage.output_tokens != null && reasoning > usage.output_tokens) {
      return invalid;
    }
    return reported(
      {
        inputTokens: difference(usage.input_tokens, usage.input_tokens_details?.cached_tokens),
        cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        reasoningTokens: reasoning,
      },
      response.model !== modelId
        ? "model_unknown"
        : response.service_tier !== "default"
          ? "tier_unknown"
          : "standard",
    );
  }
  if (provider === "anthropic") {
    const parsed = anthropicUsage.safeParse(rawUsage);
    if (!parsed.success) return invalid;
    const usage = parsed.data;
    const writes = usage.cache_creation_input_tokens;
    // A reported aggregate zero proves both TTLs are zero; an absent aggregate
    // or an unlabelled positive write count cannot establish either TTL.
    const short = usage.cache_creation?.ephemeral_5m_input_tokens ?? (writes === 0 ? 0 : null);
    const long = usage.cache_creation?.ephemeral_1h_input_tokens ?? (writes === 0 ? 0 : null);
    if (
      writes != null &&
      short != null &&
      long != null &&
      BigInt(short) + BigInt(long) !== BigInt(writes)
    ) {
      return invalid;
    }
    const unsupported =
      Object.values(usage.server_tool_use ?? {}).some((value) => value !== 0) ||
      (usage.inference_geo != null && usage.inference_geo !== "global") ||
      (usage.speed != null && usage.speed !== "standard");
    return reported(
      {
        inputTokens: usage.input_tokens ?? null,
        cachedInputTokens: usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: writes ?? null,
        cacheWrite5mTokens: short,
        cacheWrite1hTokens: long,
        outputTokens: usage.output_tokens ?? null,
      },
      response.model !== modelId
        ? "model_unknown"
        : unsupported
          ? "unsupported_dimensions"
          : usage.service_tier !== "standard"
            ? "tier_unknown"
            : "standard",
    );
  }
  if (provider === "google") {
    const parsed = googleUsage.safeParse(rawUsage);
    if (!parsed.success) return invalid;
    const usage = parsed.data;
    const unsupported =
      (usage.toolUsePromptTokenCount != null && usage.toolUsePromptTokenCount !== 0) ||
      [
        usage.promptTokensDetails,
        usage.cacheTokensDetails,
        usage.candidatesTokensDetails,
        usage.toolUsePromptTokensDetails,
      ].some((details) => details?.some((entry) => entry.modality !== "TEXT"));
    return reported(
      {
        inputTokens: difference(usage.promptTokenCount, usage.cachedContentTokenCount),
        cachedInputTokens: usage.cachedContentTokenCount ?? null,
        outputTokens: usage.candidatesTokenCount ?? null,
        reasoningTokens: usage.thoughtsTokenCount ?? null,
      },
      response.modelVersion !== modelId
        ? "model_unknown"
        : unsupported
          ? "unsupported_dimensions"
          : usage.serviceTier != null && !["standard", "unspecified"].includes(usage.serviceTier)
            ? "tier_unknown"
            : "standard",
    );
  }
  const parsed = routerUsage.safeParse(rawUsage);
  if (!parsed.success) return invalid;
  const usage = parsed.data;
  return reported(
    {
      // The router's cache-write inclusion varies by upstream. Keep the reported
      // breakdown, but do not manufacture a disjoint ordinary-input count.
      inputTokens: null,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
      cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens ?? null,
      outputTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    },
    "routing_unknown",
  );
}
