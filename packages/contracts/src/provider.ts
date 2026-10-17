import { z } from "zod";

import { uciMoveSchema } from "./game.js";

export const aiProviderSchema = z.enum(["openai", "anthropic", "google", "openrouter"]);
export const modelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^~?[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*(?![\s\S])/);
export const reasoningEffortSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*(?![\s\S])/);

// Structural bounds only; discovered capabilities determine supported values.
const parameterNumberSchema = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const outputTokenLimitSchema = z.number().int().positive();
export const aiParametersSchema = z.strictObject({
  temperature: parameterNumberSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  maxOutputTokens: outputTokenLimitSchema.optional(),
});

export const modelCapabilitiesSchema = z.strictObject({
  moveGeneration: z.enum(["supported", "unsupported", "unknown"]),
  // Null means there is no known support; it must not enable a control.
  parameters: z.strictObject({
    temperature: z
      .strictObject({ min: parameterNumberSchema, max: parameterNumberSchema })
      .refine(({ min, max }) => min <= max)
      .nullable(),
    reasoningEffort: z
      .strictObject({
        values: z
          .array(reasoningEffortSchema)
          .min(1)
          .max(32)
          .refine((values) => new Set(values).size === values.length),
      })
      .nullable(),
    maxOutputTokens: z
      .strictObject({ min: outputTokenLimitSchema, max: outputTokenLimitSchema })
      .refine(({ min, max }) => min <= max)
      .nullable(),
  }),
});

export const modelDescriptorSchema = z.strictObject({
  provider: aiProviderSchema,
  id: modelIdSchema,
  name: z.string().min(1).max(256),
  capabilities: modelCapabilitiesSchema,
});

export const aiMoveOutputSchema = z.strictObject({
  move: uciMoveSchema,
  commentary: z.string().max(2000).optional(),
});

const tokenCountSchema = z.number().int().nonnegative().nullable();
export const tokenUsageSchema = z.strictObject({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  totalTokens: tokenCountSchema,
});

export const billingDimensionsSchema = z.strictObject({
  inputTokens: tokenCountSchema.optional(),
  cachedInputTokens: tokenCountSchema.optional(),
  cacheWriteTokens: tokenCountSchema.optional(),
  cacheWrite5mTokens: tokenCountSchema.optional(),
  cacheWrite1hTokens: tokenCountSchema.optional(),
  outputTokens: tokenCountSchema.optional(),
  reasoningTokens: tokenCountSchema.optional(),
});

export const billingUsageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("reported"),
    provider: aiProviderSchema,
    pricingMatch: z.enum([
      "standard",
      "model_unknown",
      "tier_unknown",
      "unsupported_dimensions",
      "routing_unknown",
    ]),
    // Ordinary input excludes cache reads/writes. Output includes reasoning for
    // OpenAI/Anthropic/OpenRouter, but Google reports thinking separately.
    dimensions: billingDimensionsSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["usage_missing", "usage_invalid"]),
  }),
]);

// Only enumerated diagnostics cross this boundary, never upstream exception text.
export const providerFailureSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("model_invalid"),
    reason: z.enum(["malformed_output", "illegal_move", "refusal", "truncated_output"]),
  }),
  z.strictObject({ code: z.literal("provider_auth") }),
  z.strictObject({ code: z.literal("provider_quota") }),
  z.strictObject({ code: z.literal("provider_timeout") }),
  z.strictObject({
    code: z.literal("provider_unavailable"),
    reason: z.enum(["network", "upstream", "invalid_response", "unsupported_model", "cancelled"]),
  }),
]);

const invocationFields = {
  durationMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  usage: tokenUsageSchema.nullable(),
  // Optional for adapters without billing support. Broken billing metadata must
  // not change move validity, provider error classification, or the retry budget.
  billing: billingUsageSchema.optional().catch({ status: "unavailable", reason: "usage_invalid" }),
  providerRequestId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*(?![\s\S])/)
    .nullable(),
};

export const normalizedMoveResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...invocationFields, ok: z.literal(true), output: aiMoveOutputSchema }),
  z.strictObject({ ...invocationFields, ok: z.literal(false), error: providerFailureSchema }),
]);

export const modelDiscoveryResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    models: z
      .array(modelDescriptorSchema)
      .max(10_000)
      .refine(
        (models) =>
          new Set(models.map((model) => `${model.provider}:${model.id}`)).size === models.length,
      ),
  }),
  z.strictObject({ ok: z.literal(false), error: providerFailureSchema }),
]);

export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiParameters = z.infer<typeof aiParametersSchema>;
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;
export type AiMoveOutput = z.infer<typeof aiMoveOutputSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type BillingUsage = z.infer<typeof billingUsageSchema>;
export type BillingDimensions = z.infer<typeof billingDimensionsSchema>;
export type ProviderFailure = z.infer<typeof providerFailureSchema>;
export type NormalizedMoveResponse = z.infer<typeof normalizedMoveResponseSchema>;
export type ModelDiscoveryResult = z.infer<typeof modelDiscoveryResultSchema>;
