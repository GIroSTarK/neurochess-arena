import { z } from "zod";

export const authSessionResponseSchema = z.strictObject({
  session: z
    .strictObject({
      user: z.strictObject({
        id: z.string().min(1).max(128),
        email: z.email(),
        emailVerified: z.boolean(),
      }),
      expiresAt: z.iso.datetime(),
    })
    .nullable(),
});

export const authSignOutRequestSchema = z.strictObject({});
export const authSignOutResponseSchema = z.strictObject({ success: z.literal(true) });
export const authErrorCodeSchema = z.enum([
  "AUTH_UNAUTHORIZED",
  "AUTH_FORBIDDEN",
  "AUTH_INVALID_REQUEST",
  "AUTH_NOT_FOUND",
  "AUTH_RATE_LIMITED",
  "AUTH_UNAVAILABLE",
]);
export const authErrorResponseSchema = z.strictObject({
  code: authErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().min(1),
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;
