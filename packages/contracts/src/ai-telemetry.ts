import { z } from "zod";

const tokenCountSchema = z.number().int().nonnegative();
/** Null means unreported, including partially reported usage. Never infer missing counts. */
export const tokenUsageSchema = z.strictObject({
  inputTokens: tokenCountSchema.nullable(),
  outputTokens: tokenCountSchema.nullable(),
  totalTokens: tokenCountSchema.nullable(),
});

export const providerErrorKindSchema = z.enum([
  "provider_auth",
  "provider_quota",
  "provider_timeout",
  "provider_unavailable",
]);
export const providerErrorSchema = z.strictObject({ kind: providerErrorKindSchema });
export const modelInvalidErrorSchema = z.strictObject({
  kind: z.literal("model_invalid"),
  reason: z.enum(["malformed_output", "illegal_move"]),
});
/** Codes only; localization and retry policy belong to the consuming application. */
export const aiErrorSchema = z.discriminatedUnion("kind", [
  modelInvalidErrorSchema,
  providerErrorSchema,
]);
