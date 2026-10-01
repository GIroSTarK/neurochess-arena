import { randomInt, randomUUID } from "node:crypto";

import { authRateLimits, authSessions, authUsers, authVerifications } from "@neurochess/database";
import { eq, like, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { buildApp } from "../src/app.js";
import type * as authOptionsModule from "../src/auth/options.js";
import { createAccountAuth } from "../src/auth/service.js";

import { createTestMailbox } from "./auth-mailbox.js";

const control = vi.hoisted(() => ({
  pause: undefined as (() => Promise<void>) | undefined,
}));

// Keep the library's actual password crypto; pause only after verification so
// the test can deterministically overlap reset with session creation.
vi.mock("../src/auth/options.js", async (importOriginal) => {
  const original = await importOriginal<typeof authOptionsModule>();
  const { hashPassword, verifyPassword } = await import("better-auth/crypto");
  return {
    ...original,
    authOptions(...args: Parameters<typeof original.authOptions>) {
      const options = original.authOptions(...args);
      return {
        ...options,
        emailAndPassword: {
          ...options.emailAndPassword,
          password: {
            hash: hashPassword,
            async verify(input: Parameters<typeof verifyPassword>[0]) {
              const valid = await verifyPassword(input);
              await control.pause?.();
              return valid;
            },
          },
        },
      };
    },
  };
});

it("fences a sign-in already verifying the old password when another instance resets it", async () => {
  const database = integrationDatabase();
  const otherDatabase = integrationDatabase();
  const mailbox = createTestMailbox();
  const environment = {
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:5173",
    BETTER_AUTH_SECRET: "password-race-fixture-only-signing-secret",
  };
  const app = await buildApp({
    readiness: database,
    webOrigin: environment.WEB_ORIGIN,
    auth: createAccountAuth(database, environment, mailbox),
  });
  const other = await buildApp({
    readiness: otherDatabase,
    webOrigin: environment.WEB_ORIGIN,
    auth: createAccountAuth(otherDatabase, environment, mailbox),
  });
  const email = `${randomUUID()}@example.com`;
  const ip = `198.18.${randomInt(256)}.${randomInt(1, 255)}`;
  const verified = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const pending: Promise<unknown>[] = [];
  let userId: string | undefined;
  const post = (target: typeof app, path: string, payload: object) =>
    target.inject({
      method: "POST",
      url: `/api/auth/${path}`,
      remoteAddress: ip,
      headers: { origin: environment.WEB_ORIGIN },
      payload,
    });
  try {
    expect(
      (await post(app, "sign-up/email", { email, password: "old-password-canary" })).statusCode,
    ).toBe(200);
    const link = mailbox.link();
    expect(
      (await app.inject({ url: `${link.pathname}${link.search}`, remoteAddress: ip })).statusCode,
    ).toBe(303);
    const [user] = await database.db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, email));
    userId = user!.id;
    expect((await post(app, "request-password-reset", { email })).statusCode).toBe(200);
    const token = new URLSearchParams(mailbox.link().hash.slice(1)).get("token")!;
    control.pause = async () => {
      verified.resolve();
      await resume.promise;
    };
    const signIn = post(app, "sign-in/email", { email, password: "old-password-canary" }).then(
      (response) => response,
    );
    pending.push(signIn);
    await verified.promise;
    let resetFinished = false;
    const reset = post(other, "reset-password", { token, newPassword: "new-password-canary" }).then(
      (response) => {
        resetFinished = true;
        return response;
      },
    );
    pending.push(reset);
    // Before the fix reset finishes during the pause. With serialization it is
    // visibly waiting for the same auth-user row, so release the sign-in then.
    await vi.waitFor(
      async () => {
        const waiting = await database.db.execute(sql`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%"user"%' and pid <> pg_backend_pid()
      `);
        expect(resetFinished || Number(waiting.rows[0]?.count) > 0).toBe(true);
      },
      { timeout: 5000 },
    );
    resume.resolve();
    control.pause = undefined;
    const [signedIn, resetResult] = await Promise.all([signIn, reset]);
    expect(signedIn.statusCode).toBe(200);
    expect(resetResult.statusCode).toBe(200);
    const cookie = signedIn.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const session = await other.inject({
      url: "/api/auth/get-session",
      remoteAddress: ip,
      headers: { cookie },
    });
    expect(session.json()).toBeNull();
    expect(await database.db.$count(authSessions, eq(authSessions.userId, userId))).toBe(0);
    expect(
      (await post(other, "sign-in/email", { email, password: "old-password-canary" })).statusCode,
    ).toBe(401);
    expect(
      (await post(other, "sign-in/email", { email, password: "new-password-canary" })).statusCode,
    ).toBe(200);
  } finally {
    resume.resolve();
    control.pause = undefined;
    await Promise.allSettled(pending);
    await Promise.all([app.close(), other.close()]);
    if (userId) {
      await database.db.delete(authVerifications).where(eq(authVerifications.value, userId));
    }
    await database.db.delete(authUsers).where(eq(authUsers.email, email));
    await database.db.delete(authRateLimits).where(like(authRateLimits.key, `${ip}|%`));
    await Promise.all([database.close(), otherDatabase.close()]);
  }
});
