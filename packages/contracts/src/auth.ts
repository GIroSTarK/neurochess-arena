import { z } from "zod";

export const authEmailSchema = z.email().max(254).toLowerCase();
export const authPasswordSchema = z.string().min(12).max(128);
const authTokenSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const authSignUpRequestSchema = z.strictObject({
  email: authEmailSchema,
  password: authPasswordSchema,
});
export const authSignInRequestSchema = authSignUpRequestSchema;
export const authEmailRequestSchema = z.strictObject({ email: authEmailSchema });
export const authVerifyEmailRequestSchema = z.strictObject({ token: authTokenSchema });
export const authResetPasswordRequestSchema = z.strictObject({
  token: authTokenSchema,
  newPassword: authPasswordSchema,
});
export const authStatusResponseSchema = z.strictObject({ status: z.literal(true) });

export const authOAuthProviderSchema = z.enum(["google", "github"]);
export type AuthOAuthProvider = z.infer<typeof authOAuthProviderSchema>;
export const authMethodsResponseSchema = z.strictObject({
  email: z.boolean(),
  providers: z.array(authOAuthProviderSchema).max(2),
});
export const authOAuthRequestSchema = z.strictObject({ provider: authOAuthProviderSchema });
export const authOAuthStartResponseSchema = z.strictObject({
  url: z.url(),
  redirect: z.literal(true),
});
const callbackValue = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) =>
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
export const authOAuthCallbackQuerySchema = z.strictObject({
  state: callbackValue.optional(),
  code: callbackValue.optional(),
  error: callbackValue.optional(),
  error_description: callbackValue.optional(),
  error_uri: callbackValue.optional(),
  iss: callbackValue.optional(),
  scope: callbackValue.optional(),
  authuser: callbackValue.optional(),
  prompt: callbackValue.optional(),
  hd: callbackValue.optional(),
});

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
  "AUTH_EMAIL_UNAVAILABLE",
  "AUTH_EMAIL_NOT_VERIFIED",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_INVALID_TOKEN",
  "AUTH_OAUTH_FAILED",
  "AUTH_OAUTH_CONFLICT",
  "AUTH_REAUTHENTICATION_REQUIRED",
]);
export const authErrorResponseSchema = z.strictObject({
  code: authErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().min(1),
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;
