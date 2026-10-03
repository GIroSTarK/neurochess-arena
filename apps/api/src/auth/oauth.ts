import {
  authEmailRequestSchema,
  authOAuthProviderSchema,
  authOAuthSignInRequestSchema,
  authResetPasswordRequestSchema,
  safeProviderAvatar,
} from "@neurochess/contracts";
import type { BetterAuthPlugin } from "better-auth";
import {
  addOAuthServerContext,
  APIError,
  createAuthMiddleware,
  getOAuthState,
} from "better-auth/api";
import { z } from "zod";

import type { ApiEnvironment } from "../env.js";

const identitySchema = z.object({ email: z.email().max(254), emailVerified: z.literal(true) });
const googleSubjectSchema = z.object({ sub: z.string().min(1).max(255).regex(/^\S+$/) });
const githubSubjectSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const oauthAuthorizationEndpoints = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  github: "https://github.com/login/oauth/authorize",
} as const;

export function oauthProviders(
  environment: Pick<
    ApiEnvironment,
    "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET"
  >,
) {
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
            accessType: "online" as const,
            includeGrantedScopes: false,
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

export function oauthPolicy(): BetterAuthPlugin {
  return {
    id: "arena-oauth-policy",
    init(context) {
      // Keep the library's protocol implementation; admit only the validated
      // identity/profile projection and bind its state to the chosen provider.
      for (const provider of context.socialProviders) {
        const id = authOAuthProviderSchema.parse(provider.id);
        provider.issuer =
          id === "google" ? "https://accounts.google.com" : "https://github.com/login/oauth";
        const exchange = provider.validateAuthorizationCode;
        const getUserInfo = provider.getUserInfo;
        provider.validateAuthorizationCode = async (input) => {
          const state = await getOAuthState();
          if (state?.serverContext?.provider !== id || state.link) {
            throw new APIError("BAD_REQUEST", { code: "AUTH_OAUTH_FAILED" });
          }
          return exchange(input);
        };
        provider.getUserInfo = async (tokens) => {
          const result = await getUserInfo(tokens);
          if (!result || !identitySchema.safeParse(result.user).success) {
            throw new APIError("FORBIDDEN", { code: "AUTH_OAUTH_EMAIL_UNAVAILABLE" });
          }
          const subject =
            id === "google"
              ? googleSubjectSchema.safeParse(result.data)
              : githubSubjectSchema.safeParse(result.data);
          if (!subject.success) throw new APIError("BAD_REQUEST", { code: "AUTH_OAUTH_FAILED" });
          return {
            user: {
              ...identitySchema.parse(result.user),
              name: "",
              image: safeProviderAvatar(id, result.user.image) ?? undefined,
            },
            data: subject.data,
          };
        };
      }
    },
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/sign-in/social",
          handler: createAuthMiddleware(async (context) => {
            await addOAuthServerContext({
              provider: authOAuthSignInRequestSchema.strip().parse(context.body).provider,
            });
          }),
        },
        {
          matcher: (context) => context.path === "/request-password-reset",
          handler: createAuthMiddleware(async (context) => {
            const { email } = authEmailRequestSchema.parse(context.body);
            const found = await context.context.internalAdapter.findUserByEmail(email, {
              includeAccounts: true,
            });
            if (found && !found.accounts.some((account) => account.providerId === "credential")) {
              return context.json({ status: true });
            }
          }),
        },
        {
          matcher: (context) => context.path === "/reset-password",
          handler: createAuthMiddleware(async (context) => {
            // Better Auth would otherwise create a password login for an OAuth-only
            // user. Recovery must not become an implicit account-linking endpoint.
            const { token } = authResetPasswordRequestSchema.parse(context.body);
            const verification = await context.context.internalAdapter.findVerificationValue(
              `reset-password:${token}`,
            );
            if (
              verification &&
              !(await context.context.internalAdapter.findCredentialAccount(verification.value))
            ) {
              throw new APIError("BAD_REQUEST", { code: "INVALID_TOKEN" });
            }
          }),
        },
      ],
    },
  };
}

// No provider API access is needed after sign-in. In particular, Better Auth's
// encryptOAuthTokens covers access/refresh tokens but not the ID token column.
export const discardedOAuthTokens = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: null,
};
