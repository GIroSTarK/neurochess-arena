import type { BetterAuthOptions } from "better-auth";

import type { ApiEnvironment } from "../env.js";

import { AUTH_BASE_PATH, AUTH_COOKIE_PREFIX, AUTH_IP_HEADER } from "./constants.js";
import { authEmail, type AuthEmailSender } from "./email.js";
import { discardedOAuthTokens, oauthPolicy, oauthProviders } from "./oauth.js";

export type AuthEnvironment = Pick<
  ApiEnvironment,
  | "BETTER_AUTH_URL"
  | "BETTER_AUTH_SECRET"
  | "WEB_ORIGIN"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
>;

export { AUTH_BASE_PATH, AUTH_IP_HEADER } from "./constants.js";

export function authOptions(environment: AuthEnvironment, sender?: AuthEmailSender) {
  return {
    appName: "Neurochess Arena",
    baseURL: environment.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [environment.WEB_ORIGIN],
    socialProviders: oauthProviders(environment),
    plugins: [oauthPolicy()],
    onAPIError: { errorURL: `${environment.WEB_ORIGIN}/?auth=oauth-error` },
    emailAndPassword: {
      enabled: Boolean(sender),
      disableSignUp: !sender,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      ...(sender
        ? {
            sendResetPassword: async ({
              user,
              token,
            }: {
              user: { email: string };
              token: string;
            }) => sender.send(authEmail(environment, "reset", user.email, token)),
          }
        : {}),
    },
    emailVerification: {
      sendOnSignUp: Boolean(sender),
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      ...(sender
        ? {
            sendVerificationEmail: async ({
              user,
              token,
            }: {
              user: { email: string };
              token: string;
            }) => sender.send(authEmail(environment, "verification", user.email, token)),
          }
        : {}),
    },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      storeStateStrategy: "database",
      skipStateCookieCheck: false,
      updateAccountOnSignIn: false,
    },
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: { ...account, ...discardedOAuthTokens } }) },
        update: { before: async (account) => ({ data: { ...account, ...discardedOAuthTokens } }) },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "database",
      customRules: {
        "/sign-up/email": { window: 60, max: 3 },
        "/sign-in/email": { window: 60, max: 10 },
        "/send-verification-email": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 10 },
        "/sign-in/social": { window: 60, max: 10 },
        "/callback/*": { window: 60, max: 30 },
      },
    },
    advanced: {
      useSecureCookies: true,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      crossSubDomainCookies: { enabled: false },
      cookiePrefix: AUTH_COOKIE_PREFIX,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: [AUTH_IP_HEADER] },
      database: { generateId: "uuid", joins: false },
    },
    // Auth diagnostics may contain credentials in prose, beyond field-name redaction.
    // The HTTP boundary logs only fixed application errors.
    logger: { disabled: true },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}
