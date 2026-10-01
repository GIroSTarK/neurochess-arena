import { createHash, randomUUID } from "node:crypto";

import {
  authRateLimits,
  authUsers,
  authVerifications,
  type DatabaseConnection,
  games,
} from "@neurochess/database";
import { inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AuthEmailSender } from "../../apps/api/src/auth/email.js";
import { AUTH_IP_HEADER } from "../../apps/api/src/auth/options.js";
import { createAccountAuth } from "../../apps/api/src/auth/service.js";

import { API_ORIGIN, WEB_ORIGIN } from "./environment.js";

// Only the disposable browser-test entrypoint installs these transports and routes.
export function accountHarness(database: DatabaseConnection) {
  const emails = new Set<string>();
  const states = new Set<string>();
  const addresses = new Set<string>();
  const messages: { email: string; kind: string; link: string }[] = [];
  const grants = new Map<string, { url: URL; provider: "google" | "github"; email: string }>();
  const accessTokens = new Map<string, string>();
  const sender: AuthEmailSender = {
    async send(message) {
      emails.add(message.to);
      const link = /https?:\/\/\S+/.exec(message.text)?.[0];
      if (!link) throw new Error("Missing test email link");
      messages.push({
        email: message.to,
        kind: new URL(link).pathname === "/auth/reset-password" ? "reset" : "verification",
        link,
      });
    },
  };
  const auth = createAccountAuth(
    database,
    {
      WEB_ORIGIN,
      BETTER_AUTH_URL: API_ORIGIN,
      BETTER_AUTH_SECRET: "browser-tests-only-auth-secret-not-for-deployment",
      GOOGLE_CLIENT_ID: "google-fixture-client",
      GOOGLE_CLIENT_SECRET: "google-fixture-secret",
      GITHUB_CLIENT_ID: "github-fixture-client",
      GITHUB_CLIENT_SECRET: "github-fixture-secret",
    },
    sender,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      [
        "https://oauth2.googleapis.com/token",
        "https://github.com/login/oauth/access_token",
      ].includes(request.url)
    ) {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code") ?? "";
      const grant = grants.get(code);
      grants.delete(code);
      if (
        body.get("redirect_uri") !== grant?.url.searchParams.get("redirect_uri") ||
        createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url") !== grant.url.searchParams.get("code_challenge")
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const accessToken = randomUUID();
      accessTokens.set(accessToken, grant.email);
      const claims = {
        sub: grant.email,
        email: grant.email,
        email_verified: true,
        picture: "https://lh3.googleusercontent.com/fixture-avatar",
        iss: "https://accounts.google.com",
        aud: "google-fixture-client",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const idToken = [
        Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
        Buffer.from(JSON.stringify(claims)).toString("base64url"),
        "fixture-signature",
      ].join(".");
      return Response.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        ...(grant.provider === "google" ? { id_token: idToken } : {}),
      });
    }
    if (
      ["https://api.github.com/user", "https://api.github.com/user/emails"].includes(request.url)
    ) {
      const email = accessTokens.get(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
      );
      if (!email) return Response.json({}, { status: 401 });
      return Response.json(
        request.url.endsWith("/emails")
          ? [{ email, primary: true, verified: true }]
          : {
              id: parseInt(createHash("sha256").update(email).digest("hex").slice(0, 10), 16),
              login: "fixture",
              email: null,
              avatar_url: "https://avatars.githubusercontent.com/u/12345",
            },
      );
    }
    throw new Error("Unexpected browser fixture transport");
  };
  return {
    auth: {
      ...auth,
      async handle(request: Request, onFailure?: () => void) {
        const headers = new Headers(request.headers);
        const address = headers.get(AUTH_IP_HEADER) ?? "2001:db8::1";
        addresses.add(address);
        headers.set(AUTH_IP_HEADER, address);
        return auth.handle(new Request(request, { headers }), onFailure);
      },
    },
    install(app: FastifyInstance) {
      app.addHook("onRequest", async (request) => {
        const client =
          request.headers.cookie?.match(/(?:^|;\s*)neurochess_test_client=([a-f0-9-]+)/)?.[1] ??
          "anonymous";
        const address =
          "2001:db8:" +
          (createHash("sha256")
            .update(client)
            .digest("hex")
            .slice(0, 24)
            .match(/.{4}/g)
            ?.join(":") ?? "1");
        // Give isolated browser clients independent socket identities for real rate limits.
        Object.defineProperty(request, "ip", { value: address });
      });
      app.post("/__test__/mail", async (request, reply) => {
        const { email, kind } = z
          .object({ email: z.email(), kind: z.enum(["verification", "reset"]) })
          .parse(request.body);
        reply.header("cache-control", "no-store");
        return {
          link:
            messages.findLast((message) => message.email === email && message.kind === kind)
              ?.link ?? null,
        };
      });
      app.post("/__test__/oauth", async (request, reply) => {
        const input = z
          .object({
            provider: z.enum(["google", "github"]),
            url: z.url(),
            email: z.email(),
            cancel: z.boolean(),
          })
          .parse(request.body);
        const url = new URL(input.url);
        const state = url.searchParams.get("state");
        if (!state) return reply.code(400).send({});
        emails.add(input.email);
        states.add(state);
        const callback = new URL(`/api/auth/callback/${input.provider}`, API_ORIGIN);
        callback.searchParams.set("state", state);
        if (input.cancel) callback.searchParams.set("error", "access_denied");
        else {
          const code = randomUUID();
          grants.set(code, { url, provider: input.provider, email: input.email });
          callback.searchParams.set("code", code);
        }
        reply.header("cache-control", "no-store");
        return { url: callback.href };
      });
    },
    async close() {
      globalThis.fetch = originalFetch;
      if (emails.size) {
        const users = await database.db
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(inArray(authUsers.email, [...emails]));
        const ids = users.map((user) => user.id);
        if (ids.length) {
          await database.db.transaction(async (tx) => {
            await tx.delete(games).where(inArray(games.ownerUserId, ids));
            await tx.delete(authVerifications).where(inArray(authVerifications.value, ids));
            await tx.delete(authUsers).where(inArray(authUsers.id, ids));
          });
        }
      }
      if (states.size) {
        await database.db
          .delete(authVerifications)
          .where(inArray(authVerifications.identifier, [...states]));
      }
      if (addresses.size) {
        await database.db
          .delete(authRateLimits)
          .where(or(...[...addresses].map((address) => like(authRateLimits.key, `${address}|%`))));
      }
    },
  };
}
