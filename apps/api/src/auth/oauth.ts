import { authOAuthProviderSchema } from "@neurochess/contracts";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import {
  addOAuthServerContext,
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  getOAuthState,
} from "better-auth/api";
import { z } from "zod";

import type { ApiEnvironment } from "../env.js";

import type { OAuthDeletionFence } from "./oauth-deletion-fence.js";
import { protectOAuthTransport } from "./oauth-providers.js";

export type OAuthEnvironment = Pick<
  ApiEnvironment,
  "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET"
>;

export const OAUTH_COMPLETION_PATH = "/auth/complete";
export const AUTH_FRESH_AGE_SECONDS = 3600;

export function oauthProviders(
  environment: OAuthEnvironment,
): BetterAuthOptions["socialProviders"] {
  const common = {
    disableDefaultScope: true,
    disableIdTokenSignIn: true,
    overrideUserInfoOnSignIn: false,
    requireEmailVerification: true,
  };
  return {
    ...(environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            ...common,
            clientId: environment.GOOGLE_CLIENT_ID,
            clientSecret: environment.GOOGLE_CLIENT_SECRET,
            scope: ["openid", "email", "profile"],
            accessType: "online",
            includeGrantedScopes: false,
            prompt: "select_account",
          },
        }
      : {}),
    ...(environment.GITHUB_CLIENT_ID && environment.GITHUB_CLIENT_SECRET
      ? {
          github: {
            ...common,
            clientId: environment.GITHUB_CLIENT_ID,
            clientSecret: environment.GITHUB_CLIENT_SECRET,
            scope: ["user:email"],
          },
        }
      : {}),
  };
}

type AuthContext = Parameters<typeof getAuthoritativeSessionFromCtx>[0];
async function freshAccount(context: AuthContext) {
  const result = await getAuthoritativeSessionFromCtx(context);
  if (
    !result ||
    !result.user.emailVerified ||
    Date.now() - result.session.createdAt.getTime() >= AUTH_FRESH_AGE_SECONDS * 1000
  ) {
    return null;
  }
  return result;
}

export function validateOAuthIdentity(
  fence: OAuthDeletionFence,
): NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]> {
  return async ({ source, user }, context) => {
    if (source.method !== "oauth") return;
    const state = await getOAuthState();
    if (
      state?.serverContext?.provider !== source.oauth?.providerId ||
      user.emailVerified !== true
    ) {
      return { error: "AUTH_OAUTH_FAILED" };
    }
    if (
      !source.oauth ||
      typeof user.email !== "string" ||
      !(await fence.allows(
        source.oauth.providerId,
        source.oauth.profile,
        user.email,
        state?.serverContext?.startedAt,
        source.action,
      ))
    ) {
      return { error: "AUTH_OAUTH_FAILED" };
    }
    if (source.action === "link-account") {
      const current = await freshAccount(context);
      if (!current) return { error: "AUTH_REAUTHENTICATION_REQUIRED" };
      if (
        state?.serverContext?.sessionId !== current.session.id ||
        state.link?.userId !== current.user.id ||
        state.link.email.toLowerCase() !== current.user.email.toLowerCase() ||
        user.email !== current.user.email.toLowerCase()
      ) {
        return { error: "AUTH_OAUTH_CONFLICT" };
      }
    }
  };
}

export function oauthProtection(
  fetcher: typeof fetch,
  fence: OAuthDeletionFence,
): BetterAuthPlugin {
  return {
    id: "arena-oauth-policy",
    init(context) {
      return {
        context: {
          socialProviders: context.socialProviders.map((provider) => {
            const parsed = authOAuthProviderSchema.safeParse(provider.id);
            return parsed.success
              ? protectOAuthTransport(provider, parsed.data, fetcher)
              : provider;
          }),
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === "/sign-in/social" || context.path === "/link-social",
          handler: createAuthMiddleware(async (context) => {
            const { provider } = z
              .object({ provider: authOAuthProviderSchema })
              .parse(context.body);
            const current =
              context.path === "/link-social" ? await freshAccount(context) : undefined;
            if (context.path === "/link-social" && !current) {
              throw new APIError("FORBIDDEN", {
                code: "AUTH_REAUTHENTICATION_REQUIRED",
                message: "AUTH_REAUTHENTICATION_REQUIRED",
              });
            }
            await addOAuthServerContext({
              provider,
              startedAt: await fence.start(),
              ...(current ? { sessionId: current.session.id } : {}),
            });
          }),
        },
      ],
    },
  };
}

export const discardedOAuthData = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: null,
};
