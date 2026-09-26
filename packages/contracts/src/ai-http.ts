import { z } from "zod";

import { aiControlledTurnCommandSchema } from "./ai-game.js";
import { gameErrorResponseSchema } from "./game.js";
import { aiProviderSchema } from "./provider.js";

export const sessionApiKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+(?![\s\S])/);
const sessionCredentialSchema = z.strictObject({ apiKey: sessionApiKeySchema });
const savedCredentialSchema = z.strictObject({ credentialId: z.uuid() });
export const providerCredentialSourceSchema = z.union([
  sessionCredentialSchema,
  savedCredentialSchema,
]);
export const modelDiscoveryRequestSchema = z.union([
  sessionCredentialSchema.extend({ provider: aiProviderSchema }),
  savedCredentialSchema.extend({ provider: aiProviderSchema }),
]);
export const aiTurnRequestSchema = z.union([
  aiControlledTurnCommandSchema.extend(sessionCredentialSchema.shape),
  aiControlledTurnCommandSchema.extend(savedCredentialSchema.shape),
]);
export const aiRequestErrorCodeSchema = z.enum([
  "AI_TURN_IN_PROGRESS",
  "AI_TURN_RECOVERY_REQUIRED",
  "AI_TURN_CANCELLED",
  "AI_ADAPTER_UNAVAILABLE",
  "AI_PARAMETERS_INVALID",
  "AI_CONTROLLER_LOST",
  "AI_CONTROLLER_BUSY",
]);
export const aiErrorResponseSchema = z.union([
  gameErrorResponseSchema,
  z.strictObject({ code: aiRequestErrorCodeSchema, requestId: z.string().min(1) }),
]);

export type ModelDiscoveryRequest = z.infer<typeof modelDiscoveryRequestSchema>;
export type ProviderCredentialSource = z.infer<typeof providerCredentialSourceSchema>;
export type AiTurnRequest = z.infer<typeof aiTurnRequestSchema>;
export type AiRequestErrorCode = z.infer<typeof aiRequestErrorCodeSchema>;
