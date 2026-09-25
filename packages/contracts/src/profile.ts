import { z } from "zod";

import { type AuthOAuthProvider, authOAuthProviderSchema } from "./auth.js";

export const reservedUsernames = [
  "admin",
  "administrator",
  "api",
  "auth",
  "guest",
  "help",
  "moderator",
  "neurochess",
  "root",
  "sandbox",
  "security",
  "support",
  "system",
  "www",
] as const;

const displayUsernameSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?![\s\S])/)
  .refine((value) => !reservedUsernames.some((name) => name === value.toLowerCase()));
export const usernameSchema = z.string().trim().pipe(displayUsernameSchema);

export function safeProviderAvatar(
  provider: AuthOAuthProvider,
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\s<>"'`\\]/.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const approvedHost =
      provider === "google"
        ? /^lh[3-6]\.googleusercontent\.com$/.test(url.hostname)
        : url.hostname === "avatars.githubusercontent.com";
    if (
      url.protocol === "https:" &&
      approvedHost &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
    ) {
      return url.href;
    }
  } catch {
    // Invalid provider images use the username's initials.
  }
  return undefined;
}

export const providerAvatarSchema = z
  .strictObject({
    source: authOAuthProviderSchema,
    url: z.string().max(2048),
  })
  .refine(({ source, url }) => safeProviderAvatar(source, url) === url);
const initialsSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]?(?![\s\S])/)
  .nullable();
export const profileAvatarSchema = z.union([
  z.strictObject({ source: z.literal("initials"), initials: initialsSchema }),
  providerAvatarSchema.safeExtend({ initials: initialsSchema }),
]);
export const profileResponseSchema = z
  .strictObject({
    username: displayUsernameSchema.nullable(),
    onboardingRequired: z.boolean(),
    avatar: profileAvatarSchema,
    providerAvatar: providerAvatarSchema.nullable(),
  })
  .refine((profile) => profile.onboardingRequired === (profile.username === null));

export const profileOnboardingRequestSchema = z.strictObject({
  username: usernameSchema,
  avatar: z.enum(["initials", "provider"]).optional(),
});
export const profileUpdateRequestSchema = profileOnboardingRequestSchema
  .partial()
  .refine((value) => value.username !== undefined || value.avatar !== undefined);
export const profileErrorCodeSchema = z.enum([
  "PROFILE_UNAUTHORIZED",
  "PROFILE_FORBIDDEN",
  "PROFILE_INVALID_REQUEST",
  "USERNAME_UNAVAILABLE",
  "AVATAR_UNAVAILABLE",
  "PROFILE_UNAVAILABLE",
]);
export const profileErrorResponseSchema = z.strictObject({
  code: profileErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().min(1),
});
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>;
export type ProfileErrorCode = z.infer<typeof profileErrorCodeSchema>;
