import { randomInt } from "node:crypto";

import { authEmailSchema, authOAuthProviderSchema } from "@neurochess/contracts";
import { authSchema, type DatabaseConnection, games } from "@neurochess/database";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createAuth } from "../../apps/api/src/auth/service.js";
import { AUTH_ENVIRONMENT, TestMailbox } from "../../apps/api/test/auth-helpers.js";
import { OAUTH_ENVIRONMENT, TestOAuthTransport } from "../../apps/api/test/oauth-transport.js";

import { API_ORIGIN, WEB_ORIGIN } from "./environment.js";

// Mounted only by the disposable browser-test server; never imported by the product.
export async function authHarness(database: DatabaseConnection) {
  const mailbox = new TestMailbox();
  const transport = new TestOAuthTransport();
  const emails = new Set<string>();
  const states = new Set<string>();
  const auth = createAuth(
    database,
    { ...AUTH_ENVIRONMENT, ...OAUTH_ENVIRONMENT, WEB_ORIGIN, BETTER_AUTH_URL: API_ORIGIN },
    {
      emailSender: {
        async send(message) {
          emails.add(message.to);
          await mailbox.send(message);
        },
      },
      oauthFetch: transport.fetch,
    },
  );
  // Parallel browser projects share loopback. Endpoint throttling is covered by the real API integration suite.
  (await auth.$context).rateLimit.enabled = false;
  return {
    auth,
    install(app: FastifyInstance) {
      app.post("/__test__/mail", async (request) => {
        const { email, kind } = z
          .strictObject({ email: authEmailSchema, kind: z.enum(["verification", "reset"]) })
          .parse(request.body);
        return { url: mailbox.link(email, kind).href };
      });
      app.post("/__test__/oauth", async (request) => {
        const input = z
          .strictObject({
            provider: authOAuthProviderSchema,
            authorization: z.url(),
            email: authEmailSchema,
            failure: z.boolean().optional(),
          })
          .parse(request.body);
        const authorization = new URL(input.authorization);
        const state = authorization.searchParams.get("state");
        if (!state) throw new Error("TEST_STATE_REQUIRED");
        states.add(state);
        emails.add(input.email);
        const code = transport.grant({
          provider: input.provider,
          authorization,
          email: input.email,
          subject: randomInt(1, 2_000_000_000),
          ...(input.failure ? { failure: "token" as const } : {}),
        });
        const url = new URL("/api/auth/callback/" + input.provider, API_ORIGIN);
        url.searchParams.set("state", state);
        url.searchParams.set("code", code);
        return { url: url.href };
      });
    },
    async close() {
      if (emails.size) {
        const users = await database.db
          .select({ id: authSchema.user.id })
          .from(authSchema.user)
          .where(inArray(authSchema.user.email, [...emails]));
        if (users.length) {
          await database.db.transaction(async (tx) => {
            const ids = users.map((user) => user.id);
            await tx.delete(games).where(inArray(games.ownerUserId, ids));
            await tx
              .delete(authSchema.verification)
              .where(inArray(authSchema.verification.value, ids));
            await tx.delete(authSchema.user).where(inArray(authSchema.user.id, ids));
          });
        }
      }
      if (states.size) {
        await database.db
          .delete(authSchema.verification)
          .where(inArray(authSchema.verification.identifier, [...states]));
      }
    },
  };
}
