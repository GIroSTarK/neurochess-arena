import { authDeleteAccountRequestSchema } from "@neurochess/contracts";
import { createAccountRepository, type DatabaseConnection } from "@neurochess/database";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

import { AUTH_FRESH_AGE_SECONDS } from "./oauth.js";

export function accountDeletion(
  database: DatabaseConnection,
  fingerprint: (provider: string, subject: string) => string,
): BetterAuthPlugin {
  const accounts = createAccountRepository(database);
  return {
    id: "arena-account-deletion",
    endpoints: {
      deleteAccount: createAuthEndpoint(
        "/delete-account",
        {
          method: "POST",
          body: authDeleteAccountRequestSchema,
          requireHeaders: true,
        },
        async (context) => {
          const current = await getAuthoritativeSessionFromCtx({
            ...context,
            query: { disableRefresh: true },
          });
          if (!current) {
            throw new APIError("UNAUTHORIZED", {
              code: "AUTH_UNAUTHORIZED",
              message: "AUTH_UNAUTHORIZED",
            });
          }
          if (current.user.id !== context.body.expectedUserId) {
            throw new APIError("CONFLICT", {
              code: "AUTH_ACCOUNT_CHANGED",
              message: "AUTH_ACCOUNT_CHANGED",
            });
          }
          const result = await accounts.delete(
            current.user.id,
            current.session.id,
            AUTH_FRESH_AGE_SECONDS,
            fingerprint,
          );
          if (result === "unauthorized") {
            throw new APIError("UNAUTHORIZED", {
              code: "AUTH_UNAUTHORIZED",
              message: "AUTH_UNAUTHORIZED",
            });
          }
          if (result === "reauthentication_required") {
            throw new APIError("FORBIDDEN", {
              code: "AUTH_REAUTHENTICATION_REQUIRED",
              message: "AUTH_REAUTHENTICATION_REQUIRED",
            });
          }
          deleteSessionCookie(context);
          return context.json({ status: true });
        },
      ),
    },
  };
}
