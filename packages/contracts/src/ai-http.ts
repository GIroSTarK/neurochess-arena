import { z } from "zod";

import { aiTurnCommandSchema } from "./ai-game.js";
import { gameErrorResponseSchema } from "./game.js";
import { aiProviderSchema } from "./provider.js";

export const sessionApiKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+(?![\s\S])/);
export const modelDiscoveryRequestSchema = z.strictObject({
  provider: aiProviderSchema,
  apiKey: sessionApiKeySchema,
});
export const aiTurnRequestSchema = aiTurnCommandSchema.extend({ apiKey: sessionApiKeySchema });
export const aiRequestErrorCodeSchema = z.enum([
  "AI_TURN_IN_PROGRESS",
  "AI_TURN_RECOVERY_REQUIRED",
  "AI_TURN_CANCELLED",
  "AI_ADAPTER_UNAVAILABLE",
  "AI_PARAMETERS_INVALID",
]);
export const aiErrorResponseSchema = z.union([
  gameErrorResponseSchema,
  z.strictObject({ code: aiRequestErrorCodeSchema, requestId: z.string().min(1) }),
]);

export type ModelDiscoveryRequest = z.infer<typeof modelDiscoveryRequestSchema>;
export type AiTurnRequest = z.infer<typeof aiTurnRequestSchema>;
export type AiRequestErrorCode = z.infer<typeof aiRequestErrorCodeSchema>;
