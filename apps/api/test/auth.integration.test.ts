import { randomInt, randomUUID } from "node:crypto";

import { authSessionResponseSchema, gameSnapshotSchema } from "@neurochess/contracts";
import {
  authAccounts,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications,
  createAuthDatabaseAdapter,
  createGameRepository,
  games,
  guestSessions,
} from "@neurochess/database";
import { betterAuth } from "better-auth/minimal";
import { eq, inArray, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { integrationDatabase } from "../../../test/database.js";
import { buildApp } from "../src/app.js";
import { authOptions } from "../src/auth/options.js";
import { createAccountAuth } from "../src/auth/service.js";
import { createGameService } from "../src/games/service.js";
import { createGuestService, GUEST_COOKIE_NAME } from "../src/guests/service.js";
import { createLoggerOptions } from "../src/logger.js";

const environment = {
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "test-only-auth-secret-canary-unique-to-this-fixture",
  WEB_ORIGIN: "http://localhost:5173",
};
const accountFixtureSchema = z.object({ token: z.string(), user: z.object({ id: z.uuid() }) });
let database: ReturnType<typeof integrationDatabase>;
let auth: ReturnType<typeof createAccountAuth>;
let app: Awaited<ReturnType<typeof buildApp>>;
let ip: string;
const users: string[] = [];
const guests: string[] = [];
const verificationIds: string[] = [];
const logs: string[] = [];

beforeEach(async () => {
  database = integrationDatabase();
  auth = createAccountAuth(database, environment);
  ip = `198.18.${randomInt(256)}.${randomInt(1, 255)}`;
  const repository = createGameRepository(database);
  app = await buildApp({
    readiness: database,
    webOrigin: environment.WEB_ORIGIN,
    auth,
    logger: {
      ...createLoggerOptions("info"),
      stream: {
        write(chunk: string) {
          logs.push(chunk);
        },
      },
    },
    gameApi: {
      games: createGameService(repository, {
        nodeEnv: "test",
        sandboxEnabled: true,
        aiAdapters: {},
      }),
      guests: createGuestService(repository, 3600),
    },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  if (guests.length) {
    await database.db.delete(games).where(inArray(games.ownerGuestSessionId, guests));
    await database.db.delete(guestSessions).where(inArray(guestSessions.id, guests.splice(0)));
  }
  if (users.length) {
    await database.db.delete(authUsers).where(inArray(authUsers.id, users.splice(0)));
  }
  if (verificationIds.length) {
    await database.db
      .delete(authVerifications)
      .where(inArray(authVerifications.id, verificationIds.splice(0)));
  }
  await database.db.delete(authRateLimits).where(like(authRateLimits.key, `${ip}|%`));
  await database.close();
  logs.length = 0;
});

async function accountFixture() {
  // Registration exists only in this test-owned instance; production has no enable flag.
  const fixture = betterAuth({
    ...authOptions(environment),
    database: createAuthDatabaseAdapter(database),
    emailAndPassword: { enabled: true, disableSignUp: false },
  });
  const response = await fixture.api.signUpEmail({
    body: {
      name: "Fixture",
      email: `${randomUUID()}@example.com`,
      password: "test-password-canary-only",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const result = accountFixtureSchema.parse(await response.json());
  users.push(result.user.id);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const [storedSession] = await database.db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.token, result.token));
  if (!storedSession) throw new Error("Fixture session is missing");
  return {
    ...result,
    sessionId: storedSession.id,
    cookie,
    setCookies: response.headers.getSetCookie(),
    fixture,
  };
}

function session(cookie?: string) {
  return app.inject({
    url: "/api/auth/get-session",
    remoteAddress: ip,
    headers: cookie ? { cookie } : {},
  });
}

describe("PostgreSQL Better Auth foundation", () => {
  it("permits ongoing session observation without accumulating a minute-long inactivity budget", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let count = 0; count < 110; count++) {
      expect((await session()).statusCode).toBe(200);
      now += 15_000;
    }
  });
  it("creates a real account/session fixture, projects it safely, renews secure cookies, and invalidates it across instances", async () => {
    const account = await accountFixture();
    const otherDatabase = integrationDatabase();
    try {
      const other = createAccountAuth(otherDatabase, environment);
      expect(await other.resolve(new Headers({ cookie: account.cookie }))).toEqual({
        kind: "account",
        userId: account.user.id,
        sessionId: account.sessionId,
      });
      expect(await database.db.$count(authAccounts, eq(authAccounts.userId, account.user.id))).toBe(
        1,
      );
      const [storedAccount] = await database.db
        .select()
        .from(authAccounts)
        .where(eq(authAccounts.userId, account.user.id));
      expect(storedAccount?.password).not.toBe("test-password-canary-only");
      await database.db
        .update(authSessions)
        .set({ expiresAt: new Date(Date.now() + 86_400_000) })
        .where(eq(authSessions.userId, account.user.id));
      const response = await session(account.cookie);
      expect(response.statusCode).toBe(200);
      const projected = authSessionResponseSchema.parse(response.json());
      expect(projected?.user.id).toBe(account.user.id);
      expect(Object.keys(response.json())).toEqual(["user", "session"]);
      expect(response.body).not.toContain(account.token);
      expect(Object.keys(response.json<{ session: object }>().session)).toEqual(["expiresAt"]);
      const renewedCookies = response.cookies;
      expect(renewedCookies.length).toBeGreaterThan(0);
      for (const cookie of renewedCookies) {
        expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
        expect(cookie.domain).toBeUndefined();
      }
      expect(account.setCookies.join(";")).not.toContain("session_data=");
      const signOut = await app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        remoteAddress: ip,
        payload: {},
        headers: { origin: environment.WEB_ORIGIN, cookie: account.cookie },
      });
      expect(signOut.statusCode).toBe(200);
      expect(signOut.json()).toEqual({ success: true });
      expect(signOut.cookies.length).toBeGreaterThan(1);
      expect(signOut.cookies.every((cookie) => cookie.maxAge === 0)).toBe(true);
      expect(await database.db.$count(authSessions, eq(authSessions.userId, account.user.id))).toBe(
        0,
      );
      expect(await other.resolve(new Headers({ cookie: account.cookie }))).toBeNull();
      expect((await session(account.cookie)).json()).toBeNull();
      expect(logs.join("")).not.toContain(account.token);
      expect(logs.join("")).not.toContain(account.cookie);
    } finally {
      await otherDatabase.close();
    }
  });

  it("rejects missing, forged, unsigned, expired and revoked sessions without guest fallback", async () => {
    const account = await accountFixture();
    const cookieName = account.cookie.split("=")[0]!;
    for (const cookie of [
      undefined,
      `${cookieName}=forged`,
      `${cookieName}=${account.token}`,
      `${account.cookie}tampered`,
      `${GUEST_COOKIE_NAME}=guest-token-canary`,
    ]) {
      const response = await session(cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toBeNull();
      expect(await auth.resolve(new Headers(cookie ? { cookie } : {}))).toBeNull();
    }
    await database.db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.userId, account.user.id));
    expect((await session(account.cookie)).json()).toBeNull();
    expect(await auth.resolve(new Headers({ cookie: account.cookie }))).toBeNull();
  });

  it("keeps registration, password, OAuth, profile mutation, and deletion unavailable", async () => {
    const account = await accountFixture();
    for (const path of [
      "sign-up/email",
      "sign-in/email",
      "request-password-reset",
      "reset-password",
      "verify-email",
      "sign-in/social",
      "callback/google",
      "link-social",
      "update-user",
      "delete-user",
      "delete-user/callback",
      "get-access-token",
      "list-sessions",
    ]) {
      for (const method of ["GET", "POST"] as const) {
        const response = await app.inject({
          method,
          url: `/api/auth/${path}`,
          remoteAddress: ip,
          headers: { origin: environment.WEB_ORIGIN, cookie: account.cookie },
          ...(method === "POST" ? { payload: {} } : {}),
        });
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain(account.token);
      }
    }
    expect(await database.db.$count(authUsers, eq(authUsers.id, account.user.id))).toBe(1);
    const disabledSignUp = await auth.handle(
      new Request(`${environment.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          origin: environment.WEB_ORIGIN,
          "content-type": "application/json",
          "x-neurochess-client-ip": ip,
        },
        body: JSON.stringify({
          name: "Forbidden",
          email: "disabled@example.com",
          password: "fixture-password-only",
        }),
      }),
    );
    expect(disabledSignUp.status).toBeGreaterThanOrEqual(400);
    const options = authOptions(environment);
    expect(options.account.accountLinking).toEqual({
      enabled: false,
      disableImplicitLinking: true,
    });
    expect(options.user.deleteUser.enabled).toBe(false);
  });

  it("rejects untrusted origins and cross-site mutations, preserves session validity, and restricts CORS", async () => {
    const account = await accountFixture();
    for (const origin of [
      undefined,
      "https://attacker.example",
      "http://localhost:5173.attacker.example",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        remoteAddress: ip,
        headers: { cookie: account.cookie, ...(origin ? { origin } : {}) },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const untrusted = await auth.handle(
      new Request(`${environment.BETTER_AUTH_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
          cookie: account.cookie,
          "x-neurochess-client-ip": ip,
        },
        body: "{}",
      }),
    );
    expect(untrusted.status).toBe(403);
    expect(await auth.resolve(new Headers({ cookie: account.cookie }))).toEqual({
      kind: "account",
      userId: account.user.id,
      sessionId: account.sessionId,
    });
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/sign-out",
      headers: {
        origin: environment.WEB_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(environment.WEB_ORIGIN);
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("enforces the database-backed rate limit across instances despite spoofed forwarding headers", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const other = createAccountAuth(database, environment);
    const secondApp = await buildApp({
      readiness: database,
      webOrigin: environment.WEB_ORIGIN,
      auth: other,
    });
    try {
      for (let index = 0; index < 60; index++) {
        const response = await (index % 2 ? app : secondApp).inject({
          url: "/api/auth/get-session",
          remoteAddress: ip,
          headers: {
            "x-forwarded-for": `192.0.2.${index}`,
            "x-neurochess-client-ip": `192.0.2.${index}`,
          },
        });
        expect(response.statusCode).toBe(200);
      }
      const limited = await session();
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      vi.mocked(Date.now).mockReturnValue(now + 1001);
      expect((await session()).statusCode).toBe(200);
    } finally {
      await secondApp.close();
    }
  });

  it("persists and consumes verification fixtures through the real adapter and cascades account/session records", async () => {
    const account = await accountFixture();
    const context = await account.fixture.$context;
    const verification = await context.internalAdapter.createVerificationValue({
      identifier: randomUUID(),
      value: "verification-token-canary",
      expiresAt: new Date(Date.now() + 60_000),
    });
    verificationIds.push(verification.id);
    expect(
      await database.db.$count(authVerifications, eq(authVerifications.id, verification.id)),
    ).toBe(1);
    await context.internalAdapter.deleteVerificationByIdentifier(verification.identifier);
    expect(
      await database.db.$count(authVerifications, eq(authVerifications.id, verification.id)),
    ).toBe(0);
    await database.db.delete(authUsers).where(eq(authUsers.id, account.user.id));
    expect(await database.db.$count(authAccounts, eq(authAccounts.userId, account.user.id))).toBe(
      0,
    );
    expect(await database.db.$count(authSessions, eq(authSessions.userId, account.user.id))).toBe(
      0,
    );
    expect((await session(account.cookie)).json()).toBeNull();
  });

  it("keeps guest gameplay and Sandbox authority unchanged when account cookies coexist", async () => {
    const account = await accountFixture();
    const bootstrap = await app.inject({
      method: "POST",
      url: "/guest-session",
      payload: {},
      headers: { origin: environment.WEB_ORIGIN },
    });
    const token = bootstrap.cookies.find((cookie) => cookie.name === GUEST_COOKIE_NAME)!.value;
    const guest = await createGuestService(createGameRepository(database), 3600).authenticate(
      token,
    );
    guests.push(guest.principal.guestSessionId);
    const cookies = `${account.cookie}; ${GUEST_COOKIE_NAME}=${token}`;
    const created = await app.inject({
      method: "POST",
      url: "/sandbox/games",
      payload: {},
      headers: { origin: environment.WEB_ORIGIN, cookie: cookies },
    });
    expect(created.statusCode).toBe(201);
    const id = gameSnapshotSchema.parse(created.json()).gameId;
    const [record] = await database.db.select().from(games).where(eq(games.id, id));
    expect(record?.ownerGuestSessionId).toBe(guest.principal.guestSessionId);
    expect(
      (await app.inject({ url: `/games/${id}`, headers: { cookie: account.cookie } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: `/games/${id}`, headers: { cookie: cookies } })).statusCode,
    ).toBe(200);
    expect(await auth.resolve(new Headers({ cookie: cookies }))).toEqual({
      kind: "account",
      userId: account.user.id,
      sessionId: account.sessionId,
    });
  });

  it("keeps secrets out of logs, malformed-request errors, and unavailable-database responses", async () => {
    const account = await accountFixture();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const canary = "auth-boundary-secret-canary";
    for (const request of [
      { method: "GET" as const, url: `/api/auth/reset-password/${canary}?token=${canary}` },
      { method: "POST" as const, url: "/api/auth/sign-out", payload: `{"password":"${canary}"` },
      {
        method: "POST" as const,
        url: "/api/auth/sign-up/email",
        payload: {
          password: canary,
          secret: environment.BETTER_AUTH_SECRET,
          accessToken: canary,
          refreshToken: canary,
        },
      },
    ]) {
      const response = await app.inject({
        ...request,
        remoteAddress: ip,
        headers: {
          origin: environment.WEB_ORIGIN,
          cookie: account.cookie,
          authorization: `Bearer ${canary}`,
          "content-type": "application/json",
        },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain(canary);
    }
    const closedDatabase = integrationDatabase();
    const unavailable = createAccountAuth(closedDatabase, environment);
    await closedDatabase.close();
    const failingApp = await buildApp({
      readiness: database,
      webOrigin: environment.WEB_ORIGIN,
      auth: unavailable,
    });
    try {
      const response = await failingApp.inject({
        url: "/api/auth/get-session",
        remoteAddress: ip,
        headers: { cookie: account.cookie },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
      expect(response.body).not.toContain(account.token);
    } finally {
      await failingApp.close();
    }
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    for (const secret of [
      canary,
      environment.BETTER_AUTH_SECRET,
      account.token,
      account.cookie,
      "test-password-canary-only",
    ]) {
      expect(logs.join("")).not.toContain(secret);
    }
  });

  it("does not acknowledge sign-out when the auth library catches a failed database deletion", async () => {
    const account = await accountFixture();
    const originalTransaction = database.db.transaction.bind(database.db);
    const deletion = vi.spyOn(database.db, "transaction").mockImplementation((action, config) =>
      originalTransaction(async (tx) => {
        const originalDelete = tx.delete.bind(tx);
        vi.spyOn(tx, "delete").mockImplementation((table) => {
          if (table === authSessions) throw new Error("database-deletion-secret-canary");
          return originalDelete(table);
        });
        return action(tx);
      }, config),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      remoteAddress: ip,
      headers: { origin: environment.WEB_ORIGIN, cookie: account.cookie },
      payload: {},
    });
    deletion.mockRestore();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(await auth.resolve(new Headers({ cookie: account.cookie }))).toEqual({
      kind: "account",
      userId: account.user.id,
      sessionId: account.sessionId,
    });
    expect(logs.join("")).not.toContain("database-deletion-secret-canary");
  });
});
