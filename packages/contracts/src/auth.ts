import { z } from "zod";

export const gameIdentityIntentSchema = z.enum(["account", "guest"]).optional();
export const expectedAccountSchema = z.union([z.uuid(), z.literal("guest")]).optional();

export const authEmptyRequestSchema = z.strictObject({});
export const authOAuthProviderSchema = z.enum(["google", "github"]);
export const authOAuthSignInRequestSchema = z.strictObject({ provider: authOAuthProviderSchema });
export const authOAuthSignInResponseSchema = z.strictObject({ url: z.url().max(8192) });
export const authOAuthCallbackQuerySchema = z
  .strictObject({
    state: z.string().min(1).max(256),
    code: z.string().min(1).max(2048).optional(),
    error: z.string().min(1).max(256).optional(),
    error_description: z.string().max(2048).optional(),
    error_uri: z.string().max(2048).optional(),
    iss: z.url().max(256).optional(),
    scope: z.string().max(2048).optional(),
    authuser: z.string().max(32).optional(),
    prompt: z.string().max(256).optional(),
    hd: z.string().max(254).optional(),
  })
  .refine((query) => Boolean(query.code) !== Boolean(query.error));
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
  "AUTH_OAUTH_FAILED",
  "AUTH_OAUTH_CANCELLED",
  "AUTH_OAUTH_EMAIL_UNAVAILABLE",
  "AUTH_OAUTH_ACCOUNT_CONFLICT",
]);
export const authErrorResponseSchema = z.strictObject({
  code: authErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().min(1),
});

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;
export type AuthOAuthProvider = z.infer<typeof authOAuthProviderSchema>;
