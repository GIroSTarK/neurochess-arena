import { AsyncLocalStorage } from "node:async_hooks";

import { authEmailRequestSchema } from "@neurochess/contracts";
import { createAuthAdapter, type DatabaseConnection } from "@neurochess/database";
import type { Auth } from "better-auth";
import { generateRandomString } from "better-auth/crypto";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";

import type { ApiEnvironment } from "../env.js";

import { type AuthEmailSender, sendAuthEmail } from "./email.js";
import { AuthRequestError } from "./errors.js";
import {
  AUTH_FRESH_AGE_SECONDS,
  discardedOAuthData,
  OAUTH_COMPLETION_PATH,
  type OAuthEnvironment,
  oauthProtection,
  oauthProviders,
  validateOAuthIdentity,
} from "./oauth.js";

export const AUTH_BASE_PATH = "/api/auth";
export const AUTH_COOKIE_NAME = "__Secure-neurochess.session_token";
export const AUTH_IP_HEADER = "x-neurochess-client-ip";

export function createAuth(
  database: DatabaseConnection,
  environment: Pick<ApiEnvironment, "BETTER_AUTH_URL" | "BETTER_AUTH_SECRET" | "WEB_ORIGIN"> &
    OAuthEnvironment,
  options: {
    readonly diagnostic?: (level: "warn" | "error") => void;
    readonly emailSender?: AuthEmailSender | undefined;
    readonly oauthFetch?: typeof fetch;
  } = {},
): Auth {
  const delivery = new AsyncLocalStorage<{ failed: boolean; resetAttempted: boolean }>();
  const send = async (kind: "verification" | "reset", email: string, token: string) => {
    if (!options.emailSender) throw new AuthRequestError(404);
    const scope = delivery.getStore();
    if (kind === "reset" && scope) scope.resetAttempted = true;
    try {
      await sendAuthEmail(options.emailSender, environment.WEB_ORIGIN, kind, email, token);
    } catch {
      if (scope) scope.failed = true;
      throw new AuthRequestError(503, "AUTH_EMAIL_UNAVAILABLE");
    }
  };
  const auth = betterAuth<BetterAuthOptions>({
    appName: "Neurochess Arena",
    baseURL: environment.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [environment.WEB_ORIGIN],
    database: createAuthAdapter(database),
    socialProviders: oauthProviders(environment),
    plugins: [oauthProtection(options.oauthFetch ?? fetch)],
    emailAndPassword: {
      enabled: Boolean(options.emailSender),
      disableSignUp: !options.emailSender,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      ...(options.emailSender
        ? {
            sendResetPassword: async ({ user, token }) => {
              await send("reset", user.email, token);
            },
          }
        : {}),
    },
    emailVerification: {
      // The HTTP boundary sends after sign-up commits, outside the library's transaction.
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      ...(options.emailSender
        ? {
            sendVerificationEmail: async ({ user, token }) => {
              await send("verification", user.email, token);
            },
          }
        : {}),
    },
    user: {
      deleteUser: { enabled: false },
      changeEmail: { enabled: false },
      validateUserInfo: validateOAuthIdentity,
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: [],
        allowDifferentEmails: false,
        updateUserInfoOnLink: false,
      },
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      storeStateStrategy: "database",
      skipStateCookieCheck: false,
      updateAccountOnSignIn: false,
    },
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: { ...account, ...discardedOAuthData } }) },
        update: { before: async (account) => ({ data: { ...account, ...discardedOAuthData } }) },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: AUTH_FRESH_AGE_SECONDS,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "neurochess",
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
      crossSubDomainCookies: { enabled: false },
      ipAddress: { ipAddressHeaders: [AUTH_IP_HEADER] },
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      customRules: {
        "/get-session": { window: 60, max: 60 },
        "/sign-out": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 10 },
        "/send-verification-email": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 10 },
        "/verify-email": { window: 60, max: 20 },
        "/sign-in/social": { window: 60, max: 10 },
        "/link-social": { window: 60, max: 10 },
        "/callback/*": { window: 60, max: 20 },
      },
    },
    // Library messages and arguments can contain credentials, SQL, or callback tokens.
    logger: {
      level: "warn",
      log(level) {
        if (level === "warn" || level === "error") options.diagnostic?.(level);
      },
    },
    telemetry: { enabled: false },
    onAPIError: { throw: true, errorURL: `${environment.WEB_ORIGIN}${OAUTH_COMPLETION_PATH}` },
  });
  return {
    ...auth,
    handler(request) {
      const scope = { failed: false, resetAttempted: false };
      const resetRequest =
        request.method === "POST" &&
        new URL(request.url).pathname === `${AUTH_BASE_PATH}/request-password-reset`
          ? request.clone()
          : undefined;
      return delivery.run(scope, async () => {
        const response = await auth.handler(request);
        // Better Auth 1.7.5 swallows awaited reset-mail errors. Never acknowledge failed delivery.
        if (scope.failed) throw new AuthRequestError(503, "AUTH_EMAIL_UNAVAILABLE");
        if (resetRequest && response.ok && !scope.resetAttempted) {
          // Unknown accounts must exercise submission too, or SMTP errors disclose membership.
          // This token is never persisted and cannot authorize a password reset.
          const { email } = authEmailRequestSchema.parse(await resetRequest.json());
          await send("reset", email, generateRandomString(24, "a-z", "A-Z", "0-9"));
        }
        return response;
      });
    },
  };
}

export type AuthService = ReturnType<typeof createAuth>;
