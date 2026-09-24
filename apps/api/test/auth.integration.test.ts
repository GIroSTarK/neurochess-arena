import { randomUUID } from "node:crypto";

import { authSessionResponseSchema } from "@neurochess/contracts";
import { authSchema, games } from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  AUTH_COOKIE_NAME,
  AUTH_IP_HEADER,
  type AuthService,
  createAuth,
} from "../src/auth/service.js";
import { createAccountIdentityResolver } from "../src/identity/account.js";
import { createLoggerOptions } from "../src/logger.js";

import { AUTH_ENVIRONMENT, fixtureAuth, registerFixture } from "./auth-helpers.js";
import { ApiHarness, createSandbox, type TestApi, WEB_ORIGIN } from "./helpers.js";

const harness = new ApiHarness();
const users: string[] = [];
const verifications: string[] = [];
afterEach(async () => {
  await harness.dispose();
  const database = integrationDatabase();
  try {
    if (users.length) {
      await database.db.delete(authSchema.user).where(inArray(authSchema.user.id, users));
    }
    if (verifications.length) {
      await database.db
        .delete(authSchema.verification)
        .where(inArray(authSchema.verification.id, verifications));
    }
  } finally {
    await database.close();
    users.length = 0;
    verifications.length = 0;
    vi.restoreAllMocks();
  }
});

async function setup(
  options: { logs?: string[]; decorate?: (auth: AuthService) => AuthService } = {},
) {
  let auth!: AuthService;
  const api = await harness.createApi({
    auth(database) {
      auth = createAuth(database, AUTH_ENVIRONMENT);
      return options.decorate?.(auth) ?? auth;
    },
    ...(options.logs
      ? {
          logger: {
            ...createLoggerOptions("info"),
            stream: {
              write: (chunk: string) => options.logs!.push(chunk),
            },
          },
        }
      : {}),
  });
  const fixtures = fixtureAuth(api.database);
  return {
    ...api,
    auth,
    fixtures,
    register: async () => {
      const result = await registerFixture(fixtures);
      users.push(result.userId);
      return result;
    },
  };
}

function session(api: TestApi, cookie?: string, remoteAddress = "192.0.2.1") {
  return api.app.inject({
    method: "GET",
    url: "/api/auth/get-session",
    remoteAddress,
    headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
  });
}

function accountRequest(cookie: string) {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  return { cookies: { [AUTH_COOKIE_NAME]: decodeURIComponent(value) }, headers: { cookie } };
}

describe("Better Auth PostgreSQL foundation", () => {
  it("persists actual users, accounts, sessions and verification records, projects only safe fields, and revokes sessions", async () => {
    const api = await setup();
    const account = await api.register();
    expect(
      await api.database.db.$count(
        authSchema.account,
        eq(authSchema.account.userId, account.userId),
      ),
    ).toBe(1);
    const context = await api.auth.$context;
    const verification = await context.internalAdapter.createVerificationValue({
      identifier: randomUUID(),
      value: "private-verification-canary",
      expiresAt: new Date(Date.now() + 60_000),
    });
    verifications.push(verification.id);
    expect(
      await api.database.db.$count(
        authSchema.verification,
        eq(authSchema.verification.id, verification.id),
      ),
    ).toBe(1);
    expect((await session(api)).json()).toEqual({ session: null });
    const response = await session(api, account.cookie);
    expect(response.statusCode).toBe(200);
    expect(authSessionResponseSchema.parse(response.json())).toMatchObject({
      session: {
        user: { id: account.userId, email: account.email, emailVerified: false },
      },
    });
    for (const secret of [
      account.token,
      "Private fixture name",
      "private-verification-canary",
      "ipAddress",
      "userAgent",
    ]) {
      expect(response.body).not.toContain(secret);
    }
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    const cookie = account.cookies.find((value) => value.startsWith(AUTH_COOKIE_NAME))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    const otherSession = await api.fixtures.api.signInEmail({
      body: { email: account.email, password: account.password },
      asResponse: true,
    });
    const otherCookie = otherSession.headers
      .getSetCookie()
      .find((value) => value.startsWith(AUTH_COOKIE_NAME))!
      .split(";")[0]!;
    const signedOut = await api.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { origin: WEB_ORIGIN, cookie: account.cookie },
      payload: {},
    });
    expect(signedOut.statusCode).toBe(200);
    expect(signedOut.json()).toEqual({ success: true });
    const cleared = signedOut.headers["set-cookie"];
    expect(Array.isArray(cleared)).toBe(true);
    expect((cleared as string[]).length).toBeGreaterThan(1);
    expect((cleared as string[]).every((value) => value.includes("Max-Age=0"))).toBe(true);
    expect((await session(api, account.cookie)).json()).toEqual({ session: null });
    expect((await session(api, otherCookie)).json()).toHaveProperty(
      "session.user.id",
      account.userId,
    );
    expect(
      await api.database.db.$count(
        authSchema.session,
        eq(authSchema.session.userId, account.userId),
      ),
    ).toBe(1);
    await context.internalAdapter.deleteSession(
      ((await otherSession.json()) as { token: string }).token,
    );
    expect((await session(api, otherCookie)).json()).toEqual({ session: null });
  });

  it("refreshes the signed cookie through Fastify, and invalidation is immediate across instances", async () => {
    const first = await setup();
    const second = await setup();
    const account = await first.register();
    await first.database.db
      .update(authSchema.session)
      .set({
        updatedAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(authSchema.session.userId, account.userId));
    const refreshed = await session(second, account.cookie);
    expect(refreshed.statusCode).toBe(200);
    expect(
      refreshed.cookies.find((cookie) => cookie.name === AUTH_COOKIE_NAME)?.value,
    ).toBeDefined();
    const stored = await first.database.db
      .select()
      .from(authSchema.session)
      .where(eq(authSchema.session.userId, account.userId));
    expect(stored[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await first.auth.api.signOut({ headers: new Headers({ cookie: account.cookie }) });
    expect((await session(second, account.cookie)).json()).toEqual({ session: null });
  });

  it("rejects forged, expired, and deleted account sessions without falling back to a guest", async () => {
    const api = await setup();
    const account = await api.register();
    const guest = await harness.guest(api);
    const resolve = createAccountIdentityResolver(api.auth);
    expect(await resolve({ cookies: {}, headers: {} })).toBeNull();
    const both = `${account.cookie}; ${guest.cookie}`;
    expect(await resolve(accountRequest(both))).toMatchObject({
      kind: "account",
      userId: account.userId,
    });
    for (const cookie of [
      `${AUTH_COOKIE_NAME}=forged`,
      `${AUTH_COOKIE_NAME}=${account.token}`,
      `${account.cookie.slice(0, -4)}fake`,
      `${AUTH_COOKIE_NAME}=`,
    ]) {
      expect((await session(api, cookie)).json()).toEqual({ session: null });
      await expect(resolve(accountRequest(`${cookie}; ${guest.cookie}`))).rejects.toMatchObject({
        statusCode: 401,
      });
    }
    await api.database.db
      .update(authSchema.session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSchema.session.userId, account.userId));
    await expect(resolve(accountRequest(both))).rejects.toMatchObject({ statusCode: 401 });
    expect((await session(api, account.cookie)).json()).toEqual({ session: null });
    const deleted = await api.register();
    await api.database.db.delete(authSchema.user).where(eq(authSchema.user.id, deleted.userId));
    expect((await session(api, deleted.cookie)).json()).toEqual({ session: null });
    expect(
      await api.database.db.$count(
        authSchema.session,
        eq(authSchema.session.userId, deleted.userId),
      ),
    ).toBe(0);
    expect(
      await api.database.db.$count(
        authSchema.account,
        eq(authSchema.account.userId, deleted.userId),
      ),
    ).toBe(0);
  });

  it("keeps game authorization and the Sandbox guest-only when both cookies exist", async () => {
    const api = await setup();
    const account = await api.register();
    const guest = await harness.guest(api);
    const sandbox = await createSandbox(api, guest);
    for (const [cookie, status] of [
      [account.cookie, 401],
      [`${account.cookie}; ${guest.cookie}`, 200],
    ] as const) {
      const result = await api.app.inject({
        method: "GET",
        url: `/games/${sandbox.gameId}`,
        headers: { cookie },
      });
      expect(result.statusCode).toBe(status);
    }
    expect(
      (await api.database.db.select().from(games).where(eq(games.id, sandbox.gameId)))[0]!
        .ownerGuestSessionId,
    ).toBe(guest.id);
  });

  it("blocks incomplete flows and rejects foreign/missing origins, redirects, and client identities", async () => {
    const api = await setup();
    const account = await api.register();
    for (const path of [
      "sign-up/email",
      "sign-in/email",
      "sign-in/social",
      "delete-user",
      "delete-user/callback",
      "update-user",
      "change-email",
      "link-social",
      "get-access-token",
      "list-sessions",
      "reset-password",
      "ok",
      "error",
    ]) {
      const result = await api.app.inject({
        method: "POST",
        url: `/api/auth/${path}`,
        headers: { origin: WEB_ORIGIN, cookie: account.cookie },
        payload: { email: "blocked@example.test", password: "private-canary" },
      });
      expect(result.statusCode, path).toBe(404);
      expect(result.json()).toMatchObject({ code: "AUTH_NOT_FOUND" });
    }
    for (const origin of [
      undefined,
      "null",
      "http://localhost:51730",
      "https://attacker.example",
      "http://localhost:3001",
    ]) {
      const result = await api.app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: { cookie: account.cookie, ...(origin ? { origin } : {}) },
        payload: {},
      });
      expect(result.statusCode).toBe(403);
      expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const foreignRead = await api.app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { origin: "https://attacker.example", cookie: account.cookie },
    });
    expect(foreignRead.statusCode).toBe(403);
    for (const payload of [
      { userId: account.userId },
      { callbackURL: "https://attacker.example" },
    ]) {
      const result = await api.app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: { origin: WEB_ORIGIN, cookie: account.cookie },
        payload,
      });
      expect(result.statusCode).toBe(400);
    }
    const query = await api.app.inject({
      url: "/api/auth/get-session?disableCookieCache=true&token=canary",
    });
    expect(query.statusCode).toBe(400);
    expect(query.body).not.toContain("canary");
    const cors = await api.app.inject({
      method: "OPTIONS",
      url: "/api/auth/get-session",
      headers: { origin: WEB_ORIGIN, "access-control-request-method": "GET" },
    });
    expect(cors.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(cors.headers["access-control-allow-credentials"]).toBe("true");
    expect((await session(api, account.cookie)).json()).toHaveProperty(
      "session.user.id",
      account.userId,
    );
    expect(api.auth.options.emailAndPassword).toMatchObject({
      enabled: false,
      disableSignUp: true,
    });
    expect(api.auth.options.user?.deleteUser?.enabled).toBe(false);
    expect(api.auth.options.account?.accountLinking).toMatchObject({
      enabled: true,
      disableImplicitLinking: true,
      allowDifferentEmails: false,
    });
  });

  it("enforces the library rate limit using the socket IP, not spoofed forwarding headers", async () => {
    const api = await setup();
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await api.app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        remoteAddress: "192.0.2.42",
        headers: {
          origin: WEB_ORIGIN,
          [AUTH_IP_HEADER]: `203.0.113.${attempt + 1}`,
          "x-forwarded-for": `203.0.113.${attempt + 1}`,
        },
        payload: {},
      });
      expect(result.statusCode).toBe(200);
    }
    const limited = await api.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      remoteAddress: "192.0.2.42",
      headers: { origin: WEB_ORIGIN, [AUTH_IP_HEADER]: "203.0.113.77" },
      payload: {},
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/api/auth/sign-out",
          remoteAddress: "192.0.2.43",
          headers: { origin: WEB_ORIGIN },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });

  it("keeps request paths, library diagnostics, errors, secrets and malformed requests out of responses and logs", async () => {
    const logs: string[] = [];
    const canary = "auth-boundary-secret-canary";
    const api = await setup({ logs });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const context = await api.auth.$context;
    context.logger.error(canary, { token: canary });
    context.logger.warn(canary, new Error(canary));
    for (const input of [
      { method: "GET" as const, url: `/api/auth/reset-password/${canary}?code=${canary}` },
      { method: "POST" as const, url: "/api/auth/sign-out", payload: `{"token":"${canary}",` },
    ]) {
      const result = await api.app.inject({
        ...input,
        headers: {
          origin: WEB_ORIGIN,
          cookie: `${AUTH_COOKIE_NAME}=${canary}`,
          authorization: `Bearer ${canary}`,
          "content-type": "application/json",
        },
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.body).not.toContain(canary);
    }
    const failing = await setup({
      logs,
      decorate: (auth) => ({
        ...auth,
        handler: () => {
          throw Object.assign(new Error(canary), { code: canary, name: canary });
        },
      }),
    });
    const failure = await session(failing);
    expect(failure.statusCode).toBe(500);
    expect(failure.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(failure.body).not.toContain(canary);
    expect(logs.join("")).not.toContain(canary);
    expect(logs.join("")).not.toContain(AUTH_ENVIRONMENT.BETTER_AUTH_SECRET);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("reports a failed database revocation instead of acknowledging sign-out", async () => {
    const api = await setup();
    const account = await api.register();
    const context = await api.auth.$context;
    vi.spyOn(context.internalAdapter, "deleteSession").mockRejectedValue(
      new Error("database-secret-canary"),
    );
    const result = await api.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      remoteAddress: "192.0.2.51",
      headers: { origin: WEB_ORIGIN, cookie: account.cookie },
      payload: {},
    });
    expect(result.statusCode).toBe(503);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(result.body).not.toContain("database-secret-canary");
  });
});
