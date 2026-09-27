import { authVerifyEmailRequestSchema } from "@neurochess/contracts";
import { createAccountRepository, type DatabaseConnection } from "@neurochess/database";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";
import { z } from "zod";

const verifiedIdentity = z.object({ sub: z.string().min(1), email: z.email() });

export function accountEmailVerification(database: DatabaseConnection): BetterAuthPlugin {
  const accounts = createAccountRepository(database);
  return {
    id: "arena-account-email-verification",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/verify-email",
          handler: createAuthMiddleware(async (context) => {
            const input = authVerifyEmailRequestSchema.safeParse(context.query);
            const identity = verifiedIdentity.safeParse(
              input.success
                ? await verifyJWT<unknown>(input.data.token, context.context.secret)
                : null,
            );
            if (
              !identity.success ||
              !(await accounts.verifyEmail(identity.data.sub, identity.data.email))
            ) {
              throw new APIError("UNAUTHORIZED", {
                code: "INVALID_TOKEN",
                message: "INVALID_TOKEN",
              });
            }
            // Better Auth's default email-only update could verify a new account at a deleted email.
            // The product has no email-change or verification auto-sign-in flow.
            return context.json({ status: true });
          }),
        },
      ],
    },
  };
}
