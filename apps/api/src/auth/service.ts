import { createAuthAdapter, type DatabaseConnection } from "@neurochess/database";
import type { Auth } from "better-auth";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";

import type { ApiEnvironment } from "../env.js";

export const AUTH_BASE_PATH = "/api/auth";
export const AUTH_COOKIE_NAME = "__Secure-neurochess.session_token";
export const AUTH_IP_HEADER = "x-neurochess-client-ip";

export function createAuth(
  database: DatabaseConnection,
  environment: Pick<ApiEnvironment, "BETTER_AUTH_URL" | "BETTER_AUTH_SECRET" | "WEB_ORIGIN">,
  diagnostic: (level: "warn" | "error") => void = () => undefined,
): Auth {
  return betterAuth<BetterAuthOptions>({
    appName: "Neurochess Arena",
    baseURL: environment.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [environment.WEB_ORIGIN],
    database: createAuthAdapter(database),
    emailAndPassword: { enabled: false, disableSignUp: true },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      encryptOAuthTokens: true,
      storeAccountCookie: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60,
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
      },
    },
    // Library messages and arguments can contain credentials, SQL, or callback tokens.
    logger: {
      level: "warn",
      log(level) {
        if (level === "warn" || level === "error") diagnostic(level);
      },
    },
    telemetry: { enabled: false },
    onAPIError: { throw: true },
  });
}

export type AuthService = ReturnType<typeof createAuth>;
