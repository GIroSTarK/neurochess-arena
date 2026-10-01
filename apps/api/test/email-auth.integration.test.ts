import { randomInt, randomUUID } from "node:crypto";

import { authRateLimits, authSessions, authUsers, authVerifications } from "@neurochess/database";
import { eq, inArray, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { buildApp } from "../src/app.js";
import { createAccountAuth } from "../src/auth/service.js";
import { createLoggerOptions } from "../src/logger.js";

import { createTestMailbox } from "./auth-mailbox.js";

const environment = {
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "email-lifecycle-test-only-secret-not-for-deployment",
  WEB_ORIGIN: "http://localhost:5173",
};
const password = "original-password-canary";
const newPassword = "replacement-password-canary";
let database: ReturnType<typeof integrationDatabase>;
let app: Awaited<ReturnType<typeof buildApp>>;
let mailbox: ReturnType<typeof createTestMailbox>;
let ip: string;
let email: string;
const logs: string[] = [];

beforeEach(async () => {
  database = integrationDatabase();
  mailbox = createTestMailbox();
  ip = `198.19.${randomInt(256)}.${randomInt(1, 255)}`;
  email = `${randomUUID()}@example.com`;
  app = await buildApp({
    readiness: database,
    webOrigin: environment.WEB_ORIGIN,
    auth: createAccountAuth(database, environment, mailbox),
    logger: {
      ...createLoggerOptions("info"),
      stream: { write: (chunk: string) => logs.push(chunk) },
    },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await app.close();
  const users = await database.db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, email));
  if (users.length) {
    await database.db.delete(authVerifications).where(
      inArray(
        authVerifications.value,
        users.map((user) => user.id),
      ),
    );
    await database.db.delete(authUsers).where(eq(authUsers.email, email));
  }
  await database.db.delete(authRateLimits).where(like(authRateLimits.key, `${ip}|%`));
  await database.close();
  logs.length = 0;
});

function post(path: string, payload: object, cookie?: string) {
  return app.inject({
    method: "POST",
    url: `/api/auth/${path}`,
    remoteAddress: ip,
    headers: { origin: environment.WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
    payload,
  });
}

async function register() {
  const response = await post("sign-up/email", { email, password });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "accepted" });
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(response.body).not.toContain(email);
  return response;
}

function verify(link = mailbox.link()) {
  return app.inject({ url: `${link.pathname}${link.search}`, remoteAddress: ip });
}

async function signIn(value = password) {
  const response = await post("sign-in/email", { email, password: value });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ success: true });
  const cookie = response.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  expect(cookie).not.toBe("");
  return cookie;
}

function session(cookie: string) {
  return app.inject({ url: "/api/auth/get-session", remoteAddress: ip, headers: { cookie } });
}

async function requestReset() {
  const response = await post("request-password-reset", { email });
  expect(response.statusCode).toBe(200);
  const link = mailbox.link();
  expect(link.origin).toBe(environment.WEB_ORIGIN);
  expect(link.pathname).toBe("/auth/reset-password");
  expect(link.search).toBe("");
  return new URLSearchParams(link.hash.slice(1)).get("token")!;
}

describe("verified email/password lifecycle", () => {
  it("registers, verifies, signs in, resets and revokes all sessions, then signs out through the real service", async () => {
    await register();
    expect(mailbox.messages).toHaveLength(1);
    expect(mailbox.messages[0]?.to).toBe(email);
    expect((await post("sign-in/email", { email, password })).statusCode).toBe(403);
    expect(mailbox.messages).toHaveLength(1);
    const verified = await verify();
    expect(verified.statusCode).toBe(303);
    expect(verified.headers.location).toBe(`${environment.WEB_ORIGIN}/?auth=email-verified`);
    expect(verified.headers["set-cookie"]).toBeUndefined();
    const first = await signIn();
    const second = await signIn();
    const signedIn = (await session(first)).json<{
      user: { id: string; emailVerified: boolean };
    }>();
    expect(signedIn.user.emailVerified).toBe(true);
    const token = await requestReset();
    const reset = await post("reset-password", { token, newPassword });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ success: true });
    expect(reset.headers["set-cookie"]).toBeUndefined();
    expect(await database.db.$count(authSessions, eq(authSessions.userId, signedIn.user.id))).toBe(
      0,
    );
    expect((await session(first)).json()).toBeNull();
    expect((await session(second)).json()).toBeNull();
    expect((await post("sign-in/email", { email, password })).statusCode).toBe(401);
    const replacement = await signIn(newPassword);
    expect((await post("sign-out", {}, replacement)).json()).toEqual({ success: true });
    expect((await session(replacement)).json()).toBeNull();
    for (const secret of [
      password,
      newPassword,
      token,
      mailbox.link(0).searchParams.get("token")!,
      first,
      email,
    ]) {
      expect(logs.join("")).not.toContain(secret);
      expect(reset.body).not.toContain(secret);
    }
  });

  it("uses the same generic reset and registration responses for existing and absent addresses", async () => {
    const absent = await post("request-password-reset", { email });
    expect(absent.statusCode).toBe(200);
    expect(mailbox.messages).toHaveLength(0);
    const created = await register();
    const duplicate = await post("sign-up/email", { email, password: newPassword });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual(created.json());
    expect(mailbox.messages).toHaveLength(1);
    await verify();
    const present = await post("request-password-reset", { email });
    expect(present.json()).toEqual(absent.json());
    expect(present.body).not.toContain(email);
    expect(mailbox.messages).toHaveLength(2);
  });

  it("rejects invalid, expired, and reused reset tokens and consumes a racing token only once", async () => {
    await register();
    await verify();
    expect((await post("reset-password", { token: "invalid-token", newPassword })).statusCode).toBe(
      400,
    );
    const expired = await requestReset();
    await database.db
      .update(authVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authVerifications.identifier, `reset-password:${expired}`));
    expect((await post("reset-password", { token: expired, newPassword })).statusCode).toBe(400);
    const token = await requestReset();
    for (const invalid of ["short", "a".repeat(129)]) {
      expect((await post("reset-password", { token, newPassword: invalid })).statusCode).toBe(400);
    }
    const responses = await Promise.all([
      post("reset-password", { token, newPassword }),
      post("reset-password", { token, newPassword }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    expect((await post("reset-password", { token, newPassword })).statusCode).toBe(400);
    await signIn(newPassword);
  });

  it("rejects invalid and expired verification and handles a repeated valid link without creating a session", async () => {
    await register();
    const link = mailbox.link();
    const invalid = new URL(link);
    invalid.searchParams.set("token", "invalid-token");
    expect((await verify(invalid)).statusCode).toBe(401);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_601_000);
    expect((await verify(link)).statusCode).toBe(401);
    vi.useRealTimers();
    expect((await verify(link)).statusCode).toBe(303);
    const repeated = await verify(link);
    expect(repeated.statusCode).toBe(303);
    expect(repeated.headers["set-cookie"]).toBeUndefined();
    const [user] = await database.db.select().from(authUsers).where(eq(authUsers.email, email));
    expect(await database.db.$count(authSessions, eq(authSessions.userId, user!.id))).toBe(0);
  });

  it("throttles resend across auth instances and supplies a retry delay", async () => {
    await register();
    const other = await buildApp({
      readiness: database,
      webOrigin: environment.WEB_ORIGIN,
      auth: createAccountAuth(database, environment, mailbox),
    });
    try {
      for (let index = 0; index < 3; index++) {
        const response = await (index % 2 ? other : app).inject({
          method: "POST",
          url: "/api/auth/send-verification-email",
          remoteAddress: ip,
          headers: { origin: environment.WEB_ORIGIN },
          payload: { email },
        });
        expect(response.statusCode).toBe(200);
      }
      const limited = await post("send-verification-email", { email });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(mailbox.messages).toHaveLength(4);
    } finally {
      await other.close();
    }
  });

  it("rejects unsafe destinations and malformed credentials before sending mail or changing accounts", async () => {
    for (const value of ["short", "a".repeat(129)]) {
      expect((await post("sign-up/email", { email, password: value })).statusCode).toBe(400);
    }
    for (const [path, payload] of [
      ["sign-up/email", { email, password, name: "Unchosen username" }],
      ["sign-up/email", { email, password, callbackURL: "https://attacker.example" }],
      ["request-password-reset", { email, redirectTo: "https://attacker.example" }],
      ["send-verification-email", { email, callbackURL: "//attacker.example" }],
      ["sign-in/email", { email, password, callbackURL: environment.WEB_ORIGIN }],
    ] as const) {
      expect((await post(path, payload)).statusCode).toBe(400);
    }
    expect(mailbox.messages).toHaveLength(0);
    expect(await database.db.$count(authUsers, eq(authUsers.email, email))).toBe(0);
    await register();
    const link = mailbox.link();
    link.searchParams.set("callbackURL", "https://attacker.example");
    const response = await verify(link);
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it("reports failed delivery safely and allows explicit verification resend after recovery", async () => {
    const failure = vi
      .spyOn(mailbox, "send")
      .mockRejectedValue(new Error("smtp-password-token-canary"));
    const failed = await post("sign-up/email", { email, password });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: "AUTH_EMAIL_UNAVAILABLE" });
    expect(failed.headers["set-cookie"]).toBeUndefined();
    expect(mailbox.messages).toHaveLength(0);
    failure.mockRestore();
    expect((await post("send-verification-email", { email })).statusCode).toBe(200);
    expect((await verify()).statusCode).toBe(303);
    const cookie = await signIn();
    const rejected = vi
      .spyOn(mailbox, "send")
      .mockRejectedValue(new Error("smtp-password-token-canary"));
    const reset = await post("request-password-reset", { email });
    expect(reset.statusCode).toBe(503);
    expect(reset.json()).toMatchObject({ code: "AUTH_EMAIL_UNAVAILABLE" });
    expect((await session(cookie)).json()).not.toBeNull();
    expect(logs.join("")).not.toContain("smtp-password-token-canary");
    expect(reset.body).not.toContain("smtp-password-token-canary");
    rejected.mockRestore();
  });

  it("keeps delivery failures isolated between simultaneous requests and reports resend rejection", async () => {
    await register();
    const verification = mailbox.link();
    const failedSend = vi.spyOn(mailbox, "send").mockRejectedValue(new Error("smtp-secret-canary"));
    expect((await post("send-verification-email", { email })).statusCode).toBe(503);
    failedSend.mockRestore();
    await verify(verification);
    const send = mailbox.send.bind(mailbox);
    let attempted = false;
    vi.spyOn(mailbox, "send").mockImplementation(async (message) => {
      if (!attempted) {
        attempted = true;
        throw new Error("smtp-secret-canary");
      }
      await send(message);
    });
    const results = await Promise.all([
      post("request-password-reset", { email }),
      post("request-password-reset", { email }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 503]);
    expect(mailbox.messages).toHaveLength(2);
  });

  it("commits registration before dispatching email", async () => {
    const visibleUsers: number[] = [];
    const send = mailbox.send.bind(mailbox);
    vi.spyOn(mailbox, "send").mockImplementation(async (message) => {
      visibleUsers.push(await database.db.$count(authUsers, eq(authUsers.email, email)));
      await send(message);
    });
    await register();
    expect(visibleUsers).toEqual([1]);
  });

  it("does not dispatch email when the registration transaction fails to commit", async () => {
    const transaction = database.db.transaction.bind(database.db);
    vi.spyOn(database.db, "transaction").mockImplementation(async (operation, options) =>
      transaction(async (tx) => {
        await operation(tx);
        throw new Error("registration-commit-secret-canary");
      }, options),
    );
    const response = await post("sign-up/email", { email, password });
    expect(response.statusCode).toBe(500);
    expect(mailbox.messages).toHaveLength(0);
    expect(await database.db.$count(authUsers, eq(authUsers.email, email))).toBe(0);
    expect(logs.join("")).not.toContain("registration-commit-secret-canary");
  });

  it("does not acknowledge a reset if existing sessions could not be revoked", async () => {
    await register();
    await verify();
    const cookie = await signIn();
    const token = await requestReset();
    const transaction = database.db.transaction.bind(database.db);
    const failure = vi.spyOn(database.db, "transaction").mockImplementation((operation, options) =>
      transaction(async (tx) => {
        const originalDelete = tx.delete.bind(tx);
        vi.spyOn(tx, "delete").mockImplementation((table) => {
          if (table === authSessions) throw new Error("session-deletion-secret-canary");
          return originalDelete(table);
        });
        return operation(tx);
      }, options),
    );
    const response = await post("reset-password", { token, newPassword });
    failure.mockRestore();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(response.body).not.toContain("canary");
    expect(logs.join("")).not.toContain("session-deletion-secret-canary");
    await signIn();
    expect((await post("reset-password", { token, newPassword })).statusCode).toBe(200);
    expect((await session(cookie)).json()).toBeNull();
  });
});
