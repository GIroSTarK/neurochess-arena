import { authDeleteAccountRequestSchema } from "@neurochess/contracts";
import { AccountDeletionSessionError, type AuthAccountActions } from "@neurochess/database";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

export function accountDeletion(actions?: AuthAccountActions): BetterAuthPlugin {
  return {
    id: "arena-account-deletion",
    endpoints: {
      deleteAccount: createAuthEndpoint(
        "/delete-account",
        {
          method: "POST",
          body: authDeleteAccountRequestSchema,
          use: [sensitiveSessionMiddleware],
        },
        async (context) => {
          if (!actions) throw new APIError("UNAUTHORIZED", { code: "AUTH_UNAUTHORIZED" });
          try {
            await actions.deleteAccount(context.context.session.session.id, 5 * 60);
          } catch (error) {
            if (error instanceof AccountDeletionSessionError) {
              throw new APIError(
                error.code === "AUTH_REAUTH_REQUIRED" ? "FORBIDDEN" : "UNAUTHORIZED",
                { code: error.code },
              );
            }
            throw error;
          }
          deleteSessionCookie(context);
          return context.json({ success: true });
        },
      ),
    },
  };
}
