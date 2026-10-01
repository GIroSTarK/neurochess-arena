import { z } from "zod";

export const authEmptyRequestSchema = z.strictObject({});
export const authPasswordSchema = z.string().min(12).max(128);
const emailSchema = z.email().max(254);
const tokenSchema = z.string().min(1).max(2048);
export const authRegistrationRequestSchema = z.strictObject({
  email: emailSchema,
  password: authPasswordSchema,
});
export const authSignInRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export const authEmailRequestSchema = z.strictObject({ email: emailSchema });
export const authVerificationQuerySchema = z.strictObject({ token: tokenSchema });
export const authResetPasswordRequestSchema = z.strictObject({
  token: tokenSchema,
  newPassword: authPasswordSchema,
});
export const authAcceptedResponseSchema = z.strictObject({
  status: z.literal("accepted"),
  message: z.string().min(1),
});

// This projection deliberately drops library session tokens and private metadata.
export const authSessionResponseSchema = z
  .object({
    user: z.object({
      id: z.uuid(),
      email: z.email(),
      emailVerified: z.boolean(),
    }),
    session: z.object({ expiresAt: z.iso.datetime() }),
  })
  .nullable();

export const authSignOutResponseSchema = z.strictObject({ success: z.literal(true) });
export const authSuccessResponseSchema = authSignOutResponseSchema;
export const authErrorCodeSchema = z.enum([
  "AUTH_INVALID_REQUEST",
  "AUTH_UNAUTHORIZED",
  "AUTH_FORBIDDEN",
  "AUTH_NOT_FOUND",
  "AUTH_RATE_LIMITED",
  "AUTH_UNAVAILABLE",
  "AUTH_EMAIL_NOT_VERIFIED",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_INVALID_TOKEN",
]);
export const authErrorResponseSchema = z.strictObject({
  code: authErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().min(1),
});

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;
