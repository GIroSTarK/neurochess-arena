import { z } from "zod";

import { type AuthOAuthProvider, authOAuthProviderSchema } from "./auth.js";

const reservedUsernames = new Set([
  "admin",
  "administrator",
  "api",
  "arena",
  "auth",
  "guest",
  "help",
  "login",
  "logout",
  "moderator",
  "neurochess",
  "root",
  "security",
  "support",
  "system",
  "www",
]);

export const profileUsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(24)
  .regex(/^[A-Za-z0-9_]+$/)
  .refine((value) => !reservedUsernames.has(value.toLowerCase()));

export function safeProviderAvatar(provider: AuthOAuthProvider, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\]/.test(value)) {
    return null;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  try {
    const url = new URL(value);
    const allowed =
      provider === "google"
        ? /^(?:[a-z0-9-]+\.)?googleusercontent\.com$/.test(url.hostname)
        : url.hostname === "avatars.githubusercontent.com";
    return allowed &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const initialsSchema = z.string().regex(/^(?:[A-Z0-9_]{2}|\?)$/);
export const profileAvatarSchema = z.union([
  z.strictObject({ source: z.literal("initials"), initials: initialsSchema }),
  z
    .strictObject({
      source: authOAuthProviderSchema,
      url: z.string().max(2048),
      initials: initialsSchema,
    })
    .refine((avatar) => safeProviderAvatar(avatar.source, avatar.url) !== null),
]);
export const profileResponseSchema = z
  .strictObject({
    username: profileUsernameSchema.nullable(),
    completed: z.boolean(),
    avatar: profileAvatarSchema,
  })
  .refine((profile) => profile.completed === (profile.username !== null));
export const profileOnboardingRequestSchema = z.strictObject({
  username: profileUsernameSchema,
  avatar: z.literal("remove").optional(),
});
export const profileUpdateRequestSchema = profileOnboardingRequestSchema
  .partial()
  .refine((value) => value.username !== undefined || value.avatar !== undefined);
export const profileErrorCodeSchema = z.enum([
  "PROFILE_INVALID_REQUEST",
  "PROFILE_UNAUTHORIZED",
  "PROFILE_FORBIDDEN",
  "PROFILE_USERNAME_TAKEN",
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
