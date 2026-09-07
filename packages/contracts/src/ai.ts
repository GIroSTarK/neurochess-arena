import { z } from "zod";

import { chessColorSchema, uciMoveSchema } from "./game.js";

export const providerIdSchema = z.enum(["openai", "anthropic", "google", "openrouter"]);
export const providerDescriptorSchema = z.strictObject({
  id: providerIdSchema,
  name: z.string().trim().min(1).max(120),
});

export const modelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\S+(?![\s\S])/);
export const reasoningEffortSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+(?![\s\S])/);

const temperatureRangeSchema = z
  .strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative() })
  .refine(({ min, max }) => min <= max, { path: ["max"] });
const outputTokenRangeSchema = z
  .strictObject({ min: z.number().int().positive(), max: z.number().int().positive() })
  .refine(({ min, max }) => min <= max, { path: ["max"] });

/** An absent capability means unsupported; adapters supply the model's actual limits. */
export const supportedParametersSchema = z.strictObject({
  temperature: temperatureRangeSchema.optional(),
  reasoningEffort: z
    .strictObject({
      values: z
        .array(reasoningEffortSchema)
        .min(1)
        .max(32)
        .refine((values) => new Set(values).size === values.length),
    })
    .optional(),
  maxOutputTokens: outputTokenRangeSchema.optional(),
});

export const modelDescriptorSchema = z.strictObject({
  provider: providerIdSchema,
  id: modelIdSchema,
  name: z.string().trim().min(1).max(200),
  supportedParameters: supportedParametersSchema,
});

export const modelListSchema = z
  .array(modelDescriptorSchema)
  .max(2_000)
  .refine(
    (models) =>
      new Set(models.map((model) => `${model.provider}:${model.id}`)).size === models.length,
  );

export const providerListResponseSchema = z.strictObject({
  providers: z.array(providerDescriptorSchema).max(4),
});

/** Only provider operations accept this input; it is never part of stored configuration. */
export const sessionCredentialSchema = z.strictObject({
  provider: providerIdSchema,
  apiKey: z
    .string()
    .min(1)
    .max(4_096)
    .regex(/^[\x21-\x7e]+(?![\s\S])/),
});

export const modelCatalogIdSchema = z.uuid();
export const modelDiscoveryRequestSchema = z.strictObject({
  credential: sessionCredentialSchema,
  catalogId: modelCatalogIdSchema.optional(),
});

export const aiParametersSchema = z.strictObject({
  temperature: z.number().nonnegative().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

/** Seat configuration is credential-free. Credential resolution is server-owned. */
export const aiConfigurationSchema = z.strictObject({
  provider: providerIdSchema,
  modelId: modelIdSchema,
  parameters: aiParametersSchema,
});

/** Wire structure only: the API must construct this from the authoritative aggregate. */
export const modelContextSchema = z
  .strictObject({
    fen: z.string().min(1),
    pgn: z.string().min(1),
    color: chessColorSchema,
    sideToMove: chessColorSchema,
    legalMoves: z
      .array(uciMoveSchema)
      .min(1)
      .refine((moves) => new Set(moves).size === moves.length),
  })
  .refine(({ color, sideToMove }) => color === sideToMove, { path: ["color"] });

export const aiMoveResponseSchema = z.strictObject({
  move: uciMoveSchema,
  commentary: z.string().max(2_000).optional(),
});

const tokenCountSchema = z.number().int().nonnegative();
/** Null means unreported, including partially reported usage. Never infer missing counts. */
export const tokenUsageSchema = z.strictObject({
  inputTokens: tokenCountSchema.nullable(),
  outputTokens: tokenCountSchema.nullable(),
  totalTokens: tokenCountSchema.nullable(),
});

export const aiTelemetrySchema = z.strictObject({
  latencyMs: z.number().nonnegative(),
  usage: tokenUsageSchema.nullable(),
  /** Adapter-verified response identifier only, never a request object or URL. */
  providerRequestId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_.:-]+(?![\s\S])/)
    .optional(),
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

export const normalizedMoveResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: aiMoveResponseSchema.extend(aiTelemetrySchema.shape),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: aiErrorSchema,
    ...aiTelemetrySchema.shape,
  }),
]);

export const modelDiscoveryResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: modelListSchema }),
  z.strictObject({ ok: z.literal(false), error: providerErrorSchema }),
]);

/** HTTP discovery adds an ephemeral reference; adapters never supply catalog identities. */
export const modelDiscoveryResponseSchema = z.discriminatedUnion("ok", [
  modelDiscoveryResultSchema.options[0].extend({ catalogId: modelCatalogIdSchema }),
  modelDiscoveryResultSchema.options[1],
]);

export type ProviderId = z.infer<typeof providerIdSchema>;
export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;
export type ModelId = z.infer<typeof modelIdSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type SupportedParameters = z.infer<typeof supportedParametersSchema>;
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;
export type AiParameters = z.infer<typeof aiParametersSchema>;
export type AiConfiguration = z.infer<typeof aiConfigurationSchema>;
export type ModelContext = z.infer<typeof modelContextSchema>;
export type AiMoveResponse = z.infer<typeof aiMoveResponseSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type AiTelemetry = z.infer<typeof aiTelemetrySchema>;
export type ProviderErrorKind = z.infer<typeof providerErrorKindSchema>;
export type ProviderError = z.infer<typeof providerErrorSchema>;
export type ModelInvalidError = z.infer<typeof modelInvalidErrorSchema>;
export type AiError = z.infer<typeof aiErrorSchema>;
export type NormalizedMoveResponse = z.infer<typeof normalizedMoveResponseSchema>;
export type ModelDiscoveryResult = z.infer<typeof modelDiscoveryResultSchema>;
export type ModelDiscoveryResponse = z.infer<typeof modelDiscoveryResponseSchema>;
export type SessionCredential = z.infer<typeof sessionCredentialSchema>;
export type ModelDiscoveryRequest = z.infer<typeof modelDiscoveryRequestSchema>;
export type ProviderListResponse = z.infer<typeof providerListResponseSchema>;
