import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";
import { z } from "zod";

const verificationIdentitySchema = z.object({ email: z.email(), accountId: z.uuid() });

export async function verificationIdentity(token: string, secret: string) {
  const parsed = verificationIdentitySchema.safeParse(await verifyJWT<unknown>(token, secret));
  return parsed.success ? parsed.data : undefined;
}

export function accountBoundVerification(): BetterAuthPlugin {
  return {
    id: "arena-account-bound-verification",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/verify-email",
          handler: createAuthMiddleware(async (context) => {
            const token = z.string().parse(context.query?.token);
            const identity = await verificationIdentity(token, context.context.secret);
            const found =
              identity && (await context.context.internalAdapter.findUserByEmail(identity.email));
            if (!identity || found?.user.id !== identity.accountId) {
              throw new APIError("UNAUTHORIZED", { code: "INVALID_TOKEN" });
            }
          }),
        },
      ],
    },
  };
}
