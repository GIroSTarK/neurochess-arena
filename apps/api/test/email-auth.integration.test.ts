import { randomInt, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";

import {
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications,
  createProfileRepository,
} from "@neurochess/database";
import { eq, inArray, like, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { buildApp } from "../src/app.js";
import { createAccountAuth } from "../src/auth/service.js";
import { createLoggerOptions } from "../src/logger.js";
import { createProfileService } from "../src/profiles/service.js";

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
    profiles: createProfileService(createProfileRepository(database)),
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

function controlDeliveryFailure(failed: boolean) {
  const delivery = { failed };
  const send = mailbox.send.bind(mailbox);
  vi.spyOn(mailbox, "send").mockImplementation(async (message) => {
    if (delivery.failed) throw new Error(`smtp-secret-canary ${message.to} ${message.text}`);
    await send(message);
  });
  return delivery;
}

it("deletes recovery tokens and rejects old verification links after same-email registration", async () => {
  await register();
  const oldLink = mailbox.link();
  expect((await verify(oldLink)).statusCode).toBe(303);
  const cookie = await signIn();
  const token = await requestReset();
  const deleted = await post("delete-account", { confirm: true }, cookie);
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect((await session(cookie)).json()).toBeNull();
  expect(await database.db.select().from(authUsers).where(eq(authUsers.email, email))).toEqual([]);
  expect((await post("reset-password", { token, newPassword })).statusCode).toBe(400);
  await register();
  expect((await verify(oldLink)).statusCode).toBe(401);
  expect(
    (await database.db.select().from(authUsers).where(eq(authUsers.email, email)))[0]
      ?.emailVerified,
  ).toBe(false);
  expect((await verify(mailbox.link())).statusCode).toBe(303);
});

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
  it("keeps email private in explicit username onboarding and profile updates", async () => {
    await register();
    await verify();
    const cookie = await signIn();
    const initial = await app.inject({ url: "/profile", headers: { cookie } });
    expect(initial.json()).toEqual({
      username: null,
      completed: false,
      avatar: { source: "initials", initials: "?" },
    });
    const username = `Email_${randomUUID().slice(0, 8)}`;
    for (const url of ["/profile/onboarding", "/profile"]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { cookie, origin: environment.WEB_ORIGIN },
        payload: { username },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        username,
        completed: true,
        avatar: { source: "initials", initials: "EM" },
      });
      expect(response.body).not.toContain(email);
    }
    const second = await signIn();
    expect(
      (await app.inject({ url: "/profile", headers: { cookie: second } })).json(),
    ).toMatchObject({ username });
  });

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

  it("acknowledges requests without claiming delivery and allows explicit resend after recovery", async () => {
    const failure = vi
      .spyOn(mailbox, "send")
      .mockRejectedValue(new Error("smtp-password-token-canary"));
    const failed = await post("sign-up/email", { email, password });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ status: "accepted" });
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
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual(failed.json());
    expect((await session(cookie)).json()).not.toBeNull();
    expect(logs.join("")).not.toContain("smtp-password-token-canary");
    expect(logs.join("")).toContain('"event":"auth_email_delivery_failed"');
    expect(reset.body).not.toContain("smtp-password-token-canary");
    rejected.mockRestore();
  });

  it("keeps simultaneous delivery outcomes independent of public acknowledgements", async () => {
    await register();
    const verification = mailbox.link();
    const failedSend = vi.spyOn(mailbox, "send").mockRejectedValue(new Error("smtp-secret-canary"));
    expect((await post("send-verification-email", { email })).statusCode).toBe(200);
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
    expect(results.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(results[0].json()).toEqual(results[1].json());
    expect(mailbox.messages).toHaveLength(2);
  });

  it.each([false, true])(
    "keeps reset responses identical for absent and present accounts with failed delivery=%s",
    async (failedDelivery) => {
      const delivery = controlDeliveryFailure(failedDelivery);
      const absent = await post("request-password-reset", { email: email.toUpperCase() });
      delivery.failed = false;
      await register();
      await verify();
      const cookie = await signIn();
      const secret = mailbox.link().searchParams.get("token")!;
      delivery.failed = failedDelivery;
      const present = await post("request-password-reset", { email: email.toUpperCase() }, cookie);
      expect(present.statusCode).toBe(200);
      expect(present.json()).toEqual(absent.json());
      expect(present.headers["set-cookie"]).toBeUndefined();
      expect(present.headers["retry-after"]).toBeUndefined();
      expect(present.body).not.toContain(email);
      expect((await session(cookie)).json()).not.toBeNull();
      expect(mailbox.messages).toHaveLength(failedDelivery ? 1 : 2);
      if (failedDelivery) expect(logs.join("")).toContain('"event":"auth_email_delivery_failed"');
      for (const value of ["smtp-secret-canary", secret, email, cookie]) {
        expect(logs.join("")).not.toContain(value);
      }
    },
  );

  it.each([false, true])(
    "keeps new and duplicate registration responses identical with failed delivery=%s",
    async (failedDelivery) => {
      if (failedDelivery) {
        vi.spyOn(mailbox, "send").mockRejectedValue(new Error("smtp-secret-canary"));
      }
      const created = await register();
      const duplicate = await post("sign-up/email", { email: email.toUpperCase(), password });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toEqual(created.json());
      expect(duplicate.headers["set-cookie"]).toBeUndefined();
      expect(mailbox.messages).toHaveLength(failedDelivery ? 0 : 1);
    },
  );

  it.each([false, true])(
    "keeps resend responses identical for absent, unverified and verified accounts with failed delivery=%s",
    async (failedDelivery) => {
      const delivery = controlDeliveryFailure(failedDelivery);
      const absent = await post("send-verification-email", { email });
      delivery.failed = false;
      await register();
      const verification = mailbox.link();
      delivery.failed = failedDelivery;
      const unverified = await post("send-verification-email", { email: email.toUpperCase() });
      await verify(verification);
      const verified = await post("send-verification-email", { email });
      for (const response of [unverified, verified]) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(absent.json());
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      expect(mailbox.messages).toHaveLength(failedDelivery ? 1 : 2);
    },
  );

  it.each(["sign-up/email", "send-verification-email", "request-password-reset"])(
    "acknowledges %s before SMTP completes and drains delivery on shutdown",
    async (path) => {
      if (path !== "sign-up/email") await register();
      const count = mailbox.messages.length;
      const sending = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const send = mailbox.send.bind(mailbox);
      vi.spyOn(mailbox, "send").mockImplementation(async (message) => {
        sending.resolve();
        await release.promise;
        await send(message);
      });
      let response: Awaited<ReturnType<typeof post>> | undefined;
      const request = post(path, path === "sign-up/email" ? { email, password } : { email }).then(
        (result) => {
          response = result;
          return result;
        },
      );
      let closing: Promise<void> | undefined;
      try {
        await sending.promise;
        await vi.waitFor(() => expect(response?.statusCode).toBe(200), { timeout: 1500 });
        expect(response!.json()).toMatchObject({ status: "accepted" });
        expect(mailbox.messages).toHaveLength(count);
        let closed = false;
        closing = app.close().then(() => {
          closed = true;
        });
        await setImmediate();
        expect(closed).toBe(false);
      } finally {
        release.resolve();
        await request;
        await (closing ?? app.close());
      }
      expect(mailbox.messages).toHaveLength(count + 1);
    },
  );

  it("does not expose failure when the internal delivery observer also fails", async () => {
    await register();
    vi.spyOn(mailbox, "send").mockRejectedValue(new Error("smtp-secret-canary"));
    const auth = createAccountAuth(database, environment, mailbox);
    try {
      const response = await auth.handle(
        new Request(`${environment.BETTER_AUTH_URL}/api/auth/request-password-reset`, {
          method: "POST",
          headers: {
            origin: environment.WEB_ORIGIN,
            "content-type": "application/json",
            "x-neurochess-client-ip": ip,
          },
          body: JSON.stringify({ email }),
        }),
        () => {
          throw new Error("telemetry-secret-canary");
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: true });
    } finally {
      await auth.close?.();
    }
  });

  it("commits registration before dispatching email", async () => {
    const visibleUsers: number[] = [];
    const send = mailbox.send.bind(mailbox);
    vi.spyOn(mailbox, "send").mockImplementation(async (message) => {
      visibleUsers.push(await database.db.$count(authUsers, eq(authUsers.email, email)));
      await send(message);
    });
    await register();
    await vi.waitFor(() => expect(visibleUsers).toEqual([1]));
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
    const failureTableName = `session_deletion_canary_${randomUUID().replaceAll("-", "")}`;
    const failureTable = sql.identifier(failureTableName);
    // A database constraint also intercepts deletion inside nested adapter transactions.
    await database.db.execute(sql`
      create table ${failureTable} (session_id uuid references ${authSessions} (id))
    `);
    try {
      await database.db.execute(sql`
        insert into ${failureTable} (session_id)
        select ${authSessions.id} from ${authSessions}
        where ${authSessions.userId} in (
          select ${authUsers.id} from ${authUsers} where ${authUsers.email} = ${email}
        )
      `);
      const response = await post("reset-password", { token, newPassword });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
      expect(response.body).not.toContain("canary");
      expect(logs.join("")).not.toContain(failureTableName);
      const retainedSession = await session(cookie);
      expect(retainedSession.statusCode).toBe(200);
      expect(retainedSession.json()).toMatchObject({ user: { email } });
    } finally {
      await database.db.execute(sql`drop table ${failureTable}`);
    }
    await signIn();
    expect((await post("reset-password", { token, newPassword })).statusCode).toBe(200);
    expect((await session(cookie)).json()).toBeNull();
  });
});
