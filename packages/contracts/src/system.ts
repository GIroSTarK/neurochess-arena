import { z } from "zod";

export const healthResponseSchema = z.strictObject({
  status: z.literal("ok"),
});

export const readinessResponseSchema = z.strictObject({
  status: z.enum(["ready", "not_ready"]),
});

export const safeErrorResponseSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export const rateLimitResponseSchema = safeErrorResponseSchema.extend({
  code: z.literal("RATE_LIMITED"),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type SafeErrorResponse = z.infer<typeof safeErrorResponseSchema>;
