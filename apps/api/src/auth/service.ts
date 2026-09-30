import { createAuthDatabaseAdapter, type DatabaseConnection } from "@neurochess/database";
import { betterAuth } from "better-auth/minimal";
import { z } from "zod";

import type { AccountPrincipal } from "../identity/principal.js";

import { AUTH_BASE_PATH, type AuthEnvironment, authOptions } from "./options.js";

export interface AccountAuth {
  readonly baseURL: string;
  handle(request: Request): Promise<Response>;
  resolve(headers: Headers): Promise<AccountPrincipal | null>;
}

export function createAccountAuth(
  database: DatabaseConnection,
  environment: AuthEnvironment,
): AccountAuth {
  const auth = betterAuth({
    ...authOptions(environment),
    database: createAuthDatabaseAdapter(database),
  });
  const getSession = (headers: Headers) =>
    auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
  return {
    baseURL: environment.BETTER_AUTH_URL,
    async handle(request) {
      const response = await auth.handler(request);
      // Better Auth's sign-out catches adapter deletion errors. Never acknowledge
      // revocation while the same server-side session can still authenticate.
      if (
        new URL(request.url).pathname === `${AUTH_BASE_PATH}/sign-out` &&
        response.ok &&
        (await getSession(request.headers))
      ) {
        throw new Error("Session revocation failed");
      }
      return response;
    },
    async resolve(headers) {
      const value = await getSession(headers);
      return value ? { kind: "account", userId: z.uuid().parse(value.user.id) } : null;
    },
  };
}
