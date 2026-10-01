import {
  authOAuthProviderSchema,
  type ProfileErrorCode,
  type ProfileResponse,
  profileResponseSchema,
  profileUpdateRequestSchema,
  profileUsernameSchema,
  safeProviderAvatar,
} from "@neurochess/contracts";
import {
  type ProfileRepository,
  type StoredProfile,
  UsernameTakenError,
} from "@neurochess/database";

import type { AccountPrincipal } from "../identity/principal.js";

export class ProfileRequestError extends Error {
  constructor(readonly code: ProfileErrorCode) {
    super(code);
  }
}

function projectProfile(stored: StoredProfile): ProfileResponse {
  const parsed = profileUsernameSchema.safeParse(stored.username);
  const username =
    parsed.success && parsed.data.toLowerCase() === stored.usernameNormalized ? parsed.data : null;
  const initials = username ? username.slice(0, 2).toUpperCase() : "?";
  let avatar: ProfileResponse["avatar"] = { source: "initials", initials };
  if (!stored.avatarRemoved) {
    for (const value of stored.providers) {
      const provider = authOAuthProviderSchema.safeParse(value);
      const url = provider.success ? safeProviderAvatar(provider.data, stored.image) : null;
      if (provider.success && url) {
        avatar = { source: provider.data, url, initials };
        break;
      }
    }
  }
  return profileResponseSchema.parse({ username, completed: username !== null, avatar });
}

export function createProfileService(repository: ProfileRepository) {
  function project(stored: StoredProfile | undefined) {
    if (!stored) throw new ProfileRequestError("PROFILE_UNAUTHORIZED");
    return projectProfile(stored);
  }
  return {
    async read(principal: AccountPrincipal) {
      return project(await repository.read(principal));
    },
    async update(principal: AccountPrincipal, input: unknown) {
      const parsed = profileUpdateRequestSchema.safeParse(input);
      if (!parsed.success) throw new ProfileRequestError("PROFILE_INVALID_REQUEST");
      try {
        return project(
          await repository.update(principal, {
            ...(parsed.data.username !== undefined ? { username: parsed.data.username } : {}),
            ...(parsed.data.avatar === "remove" ? { removeAvatar: true } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof UsernameTakenError) {
          throw new ProfileRequestError("PROFILE_USERNAME_TAKEN");
        }
        throw error;
      }
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
