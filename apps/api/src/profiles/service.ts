import {
  type ProfileErrorCode,
  type ProfileResponse,
  profileResponseSchema,
  profileUpdateRequestSchema,
  safeProviderAvatar,
} from "@neurochess/contracts";
import type { ProfileRepository, StoredProfileState } from "@neurochess/database";

import type { AccountPrincipal } from "../identity/principal.js";

export class ProfileRequestError extends Error {
  constructor(readonly code: ProfileErrorCode) {
    super("PROFILE_REQUEST_FAILED");
    this.name = "ProfileRequestError";
  }
}

function providerAvatar(state: StoredProfileState): ProfileResponse["providerAvatar"] {
  for (const source of ["google", "github"] as const) {
    if (!state.providers.includes(source)) continue;
    const url = safeProviderAvatar(source, state.image);
    if (url) return { source, url };
  }
  return null;
}

function project(state: StoredProfileState | undefined): ProfileResponse {
  if (!state) throw new ProfileRequestError("PROFILE_UNAUTHORIZED");
  const username = state.profile?.username ?? null;
  const candidate = providerAvatar(state);
  const initials = username?.replaceAll("_", "").slice(0, 2).toUpperCase() ?? null;
  return profileResponseSchema.parse({
    username,
    onboardingRequired: username === null,
    providerAvatar: candidate,
    avatar:
      state.profile?.avatarPreference !== "initials" && candidate
        ? { ...candidate, initials }
        : { source: "initials", initials },
  });
}

function usernameConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "23505" && "constraint" in error) {
    return error.constraint === "profiles_username_normalized_unique";
  }
  return "cause" in error && error.cause !== error && usernameConflict(error.cause);
}

export function createProfileService(repository: ProfileRepository) {
  return {
    async read(principal: AccountPrincipal): Promise<ProfileResponse> {
      return project(await repository.read(principal.userId, principal.sessionId));
    },
    async update(principal: AccountPrincipal, input: unknown): Promise<ProfileResponse> {
      const parsed = profileUpdateRequestSchema.safeParse(input);
      if (!parsed.success) throw new ProfileRequestError("PROFILE_INVALID_REQUEST");
      try {
        return project(
          await repository.update(principal.userId, principal.sessionId, (current) => {
            const { username, avatar } = parsed.data;
            if (avatar === "provider" && !providerAvatar(current)) {
              throw new ProfileRequestError("AVATAR_UNAVAILABLE");
            }
            return {
              ...(username !== undefined
                ? { username, usernameNormalized: username.toLowerCase() }
                : {}),
              ...(avatar !== undefined ? { avatarPreference: avatar } : {}),
            };
          }),
        );
      } catch (error) {
        if (usernameConflict(error)) throw new ProfileRequestError("USERNAME_UNAVAILABLE");
        throw error;
      }
    },
  };
}
export type ProfileService = ReturnType<typeof createProfileService>;
