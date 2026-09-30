import { z } from "zod";

export const authEmptyRequestSchema = z.strictObject({});

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
export const authErrorCodeSchema = z.enum([
  "AUTH_INVALID_REQUEST",
  "AUTH_UNAUTHORIZED",
  "AUTH_FORBIDDEN",
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
