import type { BetterAuthOptions } from "better-auth";

import type { ApiEnvironment } from "../env.js";

export type AuthEnvironment = Pick<
  ApiEnvironment,
  "BETTER_AUTH_URL" | "BETTER_AUTH_SECRET" | "WEB_ORIGIN"
>;

export const AUTH_BASE_PATH = "/api/auth";
export const AUTH_IP_HEADER = "x-neurochess-client-ip";

export function authOptions(environment: AuthEnvironment) {
  return {
    appName: "Neurochess Arena",
    baseURL: environment.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [environment.WEB_ORIGIN],
    emailAndPassword: { enabled: false, disableSignUp: true },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      encryptOAuthTokens: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, window: 60, max: 100, storage: "database" },
    advanced: {
      useSecureCookies: true,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      crossSubDomainCookies: { enabled: false },
      cookiePrefix: "neurochess",
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
