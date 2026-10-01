import { createHash, randomUUID } from "node:crypto";

import {
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications,
  type DatabaseConnection,
  games,
} from "@neurochess/database";
import { eq, inArray, like, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AuthEmailSender } from "../../apps/api/src/auth/email.js";
import { AUTH_IP_HEADER } from "../../apps/api/src/auth/options.js";
import { createAccountAuth } from "../../apps/api/src/auth/service.js";

import { API_ORIGIN, WEB_ORIGIN } from "./environment.js";

// Only the disposable browser-test entrypoint installs these transports and routes.
export function accountHarness(database: DatabaseConnection) {
  const createdUserIds = new Set<string>();
  const createdSessionIds = new Set<string>();
  const states = new Set<string>();
  const addresses = new Set<string>();
  const messages: { email: string; kind: string; link: string }[] = [];
  const grants = new Map<string, { url: URL; provider: "google" | "github"; email: string }>();
  const accessTokens = new Map<string, string>();
  const createdCallback = `${WEB_ORIGIN}/?auth=fixture-account-created`;
  const sender: AuthEmailSender = {
    async send(message) {
      const link = /https?:\/\/\S+/.exec(message.text)?.[0];
      if (!link) throw new Error("Missing test email link");
      const url = new URL(link);
      const kind = url.pathname === "/auth/reset-password" ? "reset" : "verification";
      if (kind === "reset") {
        const token = new URLSearchParams(url.hash.slice(1)).get("token");
        if (!token) throw new Error("Missing test reset token");
        states.add(`reset-password:${token}`);
      }
      messages.push({
        email: message.to,
        kind,
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
        const path = new URL(request.url).pathname;
        const social = path === "/api/auth/sign-in/social";
        const body = social
          ? JSON.stringify({
              ...z.record(z.string(), z.unknown()).parse(await request.clone().json()),
              newUserCallbackURL: createdCallback,
            })
          : undefined;
        const response = await auth.handle(
          new Request(request, { headers, ...(body ? { body } : {}) }),
          onFailure,
        );
        if (path === "/api/auth/sign-up/email" && response.ok) {
          const { user } = z
            .object({ user: z.object({ id: z.uuid() }) })
            .parse(await response.clone().json());
          // Duplicate registration returns a synthetic, unpersisted ID. Never claim
          // an existing user by looking up the email supplied to an auth operation.
          const [created] = await database.db
            .select({ id: authUsers.id })
            .from(authUsers)
            .where(eq(authUsers.id, user.id));
          if (created) createdUserIds.add(created.id);
        }
        if (social && response.ok) {
          const { url } = z.object({ url: z.url() }).parse(await response.clone().json());
          const state = new URL(url).searchParams.get("state");
          if (state) states.add(state);
        }
        const location = response.headers.get("location");
        const callbackSession =
          path.startsWith("/api/auth/callback/") &&
          (location === createdCallback || location === `${WEB_ORIGIN}/?auth=signed-in`);
        const session =
          callbackSession || (path === "/api/auth/sign-in/email" && response.ok)
            ? await auth.resolve(
                new Headers({
                  cookie: response.headers
                    .getSetCookie()
                    .map((value) => value.split(";")[0])
                    .join("; "),
                }),
              )
            : null;
        if (session) createdSessionIds.add(session.sessionId);
        // Better Auth selects this server-controlled destination only for isRegister.
        // Restore the canonical callback before the normal API bridge sees it.
        if (
          path.startsWith("/api/auth/callback/") &&
          response.headers.get("location") === createdCallback
        ) {
          if (!session) throw new Error("Created OAuth fixture session is unavailable");
          createdUserIds.add(session.userId);
          const projected = new Headers(response.headers);
          projected.set("location", `${WEB_ORIGIN}/?auth=signed-in`);
          return new Response(response.body, { status: response.status, headers: projected });
        }
        return response;
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
      if (createdSessionIds.size) {
        await database.db
          .delete(authSessions)
          .where(inArray(authSessions.id, [...createdSessionIds]));
      }
      if (createdUserIds.size) {
        const ids = [...createdUserIds];
        await database.db.transaction(async (tx) => {
          await tx.delete(games).where(inArray(games.ownerUserId, ids));
          await tx.delete(authVerifications).where(inArray(authVerifications.value, ids));
          await tx.delete(authUsers).where(inArray(authUsers.id, ids));
        });
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
