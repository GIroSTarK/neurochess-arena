import { randomUUID } from "node:crypto";

import { authSchema } from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  AUTH_COOKIE_NAME,
  AUTH_IP_HEADER,
  type AuthService,
  createAuth,
} from "../src/auth/service.js";
import { createLoggerOptions } from "../src/logger.js";

import { aiMatch } from "./ai-turn-helpers.js";
import { AUTH_ENVIRONMENT, TestMailbox } from "./auth-helpers.js";
import { ApiHarness, type TestApi, WEB_ORIGIN } from "./helpers.js";

const harness = new ApiHarness();
const emails: string[] = [];
const password = "initial-password-12-canary";
const newPassword = "replacement-password-canary";
let testAddress = 100;
beforeEach(() => {
  testAddress++;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await harness.dispose();
  const database = integrationDatabase();
  try {
    if (emails.length) {
      const users = await database.db
        .select({ id: authSchema.user.id })
        .from(authSchema.user)
        .where(inArray(authSchema.user.email, emails));
      if (users.length) {
        await database.db.delete(authSchema.verification).where(
          inArray(
            authSchema.verification.value,
            users.map(({ id }) => id),
          ),
        );
        await database.db.delete(authSchema.user).where(
          inArray(
            authSchema.user.id,
            users.map(({ id }) => id),
          ),
        );
      }
    }
  } finally {
    emails.length = 0;
    await database.close();
  }
});

function newEmail() {
  const email = `${randomUUID()}@example.test`;
  emails.push(email);
  return email;
}

async function setup() {
  const mailbox = new TestMailbox();
  const logs: string[] = [];
  let auth!: AuthService;
  const api = await harness.createApi({
    auth(database) {
      auth = createAuth(database, AUTH_ENVIRONMENT, { emailSender: mailbox });
      return auth;
    },
    logger: {
      ...createLoggerOptions("info"),
      stream: { write: (chunk: string) => logs.push(chunk) },
    },
  });
  return { ...api, auth, mailbox, logs };
}

function post(
  api: TestApi,
  path: string,
  payload: Record<string, unknown>,
  remoteAddress = `192.0.2.${testAddress}`,
  cookie?: string,
) {
  return api.app.inject({
    method: "POST",
    url: `/api/auth/${path}`,
    payload,
    remoteAddress,
    headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
  });
}

async function signIn(api: TestApi, email: string, value = password) {
  const response = await post(api, "sign-in/email", { email, password: value });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: true });
  expect(response.headers.location).toBeUndefined();
  const cookie = response.cookies.find(({ name }) => name === AUTH_COOKIE_NAME);
  expect(cookie).toBeDefined();
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(cookie!.value)}`;
}

async function readSession(api: TestApi, cookie: string) {
  return api.app.inject({ url: "/api/auth/get-session", headers: { cookie, origin: WEB_ORIGIN } });
}

async function registerVerified(api: Awaited<ReturnType<typeof setup>>) {
  const email = newEmail();
  expect((await post(api, "sign-up/email", { email, password })).statusCode).toBe(200);
  expect(
    (await post(api, "verify-email", { token: api.mailbox.token(email, "verification") }))
      .statusCode,
  ).toBe(200);
  return email;
}

describe("verified email/password lifecycle through Fastify and Better Auth", () => {
  it("requires user-chosen profile onboarding after verified password sign-in", async () => {
    const api = await setup();
    const email = await registerVerified(api);
    const cookie = await signIn(api, email);
    const read = () => api.app.inject({ url: "/api/profile", headers: { cookie } });
    const before = await read();
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      username: null,
      onboardingRequired: true,
      avatar: { source: "initials", initials: null },
    });
    expect(before.body).not.toContain(email);
    const blocked = await api.app.inject({
      method: "POST",
      url: "/games",
      payload: aiMatch,
      headers: { cookie, origin: WEB_ORIGIN },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "PROFILE_REQUIRED" });
    const username = "Email_" + randomUUID().replaceAll("-", "").slice(0, 18);
    const completed = await api.app.inject({
      method: "POST",
      url: "/api/profile/onboarding",
      payload: { username },
      headers: { cookie, origin: WEB_ORIGIN },
    });
    expect(completed.statusCode).toBe(200);
    expect((await read()).json()).toMatchObject({ username, onboardingRequired: false });
    const changed = "Changed_" + randomUUID().replaceAll("-", "").slice(0, 16);
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/api/profile",
          payload: { username: changed },
          headers: { cookie, origin: WEB_ORIGIN },
        })
      ).statusCode,
    ).toBe(200);
    expect((await read()).json()).toMatchObject({
      username: changed,
      avatar: { source: "initials", initials: "CH" },
    });
  });

  it("registers, verifies, signs in, resets all sessions, rejects the old password, and signs out", async () => {
    const api = await setup();
    const email = newEmail();
    const registration = await post(api, "sign-up/email", { email: email.toUpperCase(), password });
    expect(registration.statusCode).toBe(200);
    expect(registration.json()).toEqual({ status: true });
    expect(registration.headers["set-cookie"]).toBeUndefined();
    const [user] = await api.database.db
      .select()
      .from(authSchema.user)
      .where(eq(authSchema.user.email, email));
    expect(user).toMatchObject({ name: "", emailVerified: false });
    const before = await post(api, "sign-in/email", { email, password });
    expect(before.statusCode).toBe(403);
    expect(before.json()).toMatchObject({ code: "AUTH_EMAIL_NOT_VERIFIED" });
    expect(before.headers["set-cookie"]).toBeUndefined();
    expect(api.mailbox.messages).toHaveLength(1);

    const verificationToken = api.mailbox.token(email, "verification");
    const verified = await post(api, "verify-email", { token: verificationToken });
    expect(verified.json()).toEqual({ status: true });
    expect(verified.headers["set-cookie"]).toBeUndefined();
    // Reopening a valid verification link is idempotent and never creates a session.
    const repeated = await post(api, "verify-email", { token: verificationToken });
    expect(repeated.json()).toEqual({ status: true });
    expect(repeated.headers["set-cookie"]).toBeUndefined();
    const first = await signIn(api, email);
    const second = await signIn(api, email.toUpperCase());
    expect((await readSession(api, first)).json()).toMatchObject({
      session: { user: { emailVerified: true } },
    });

    const reset = await post(api, "request-password-reset", { email: email.toUpperCase() });
    expect(reset.json()).toEqual({ status: true });
    const token = api.mailbox.token(email, "reset");
    const completed = await post(api, "reset-password", { token, newPassword });
    expect(completed.json()).toEqual({ status: true });
    expect(completed.headers["set-cookie"]).toBeUndefined();
    for (const cookie of [first, second]) {
      expect((await readSession(api, cookie)).json()).toEqual({ session: null });
    }
    expect(
      await api.database.db.$count(authSchema.session, eq(authSchema.session.userId, user!.id)),
    ).toBe(0);
    const oldPassword = await post(api, "sign-in/email", { email, password });
    expect(oldPassword.statusCode).toBe(401);
    expect(oldPassword.json()).toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    const current = await signIn(api, email, newPassword);
    const signedOut = await post(api, "sign-out", {}, "192.0.2.80", current);
    expect(signedOut.json()).toEqual({ success: true });
    expect((await readSession(api, current)).json()).toEqual({ session: null });
    for (const secret of [
      password,
      newPassword,
      token,
      verificationToken,
      first,
      AUTH_ENVIRONMENT.BETTER_AUTH_SECRET,
    ]) {
      expect(api.logs.join("")).not.toContain(secret);
      for (const response of [
        registration,
        before,
        verified,
        reset,
        completed,
        oldPassword,
        signedOut,
      ]) {
        expect(response.body).not.toContain(secret);
      }
    }
  });

  it("uses generic signup, resend, and reset responses, without revealing account existence or changing credentials", async () => {
    const api = await setup();
    const email = await registerVerified(api);
    const cookie = await signIn(api, email);
    const unknown = newEmail();
    const duplicate = await post(api, "sign-up/email", { email, password: newPassword });
    expect(duplicate.json()).toEqual({ status: true });
    expect(duplicate.headers["set-cookie"]).toBeUndefined();
    expect(api.mailbox.messages).toHaveLength(1);
    for (const path of ["request-password-reset", "send-verification-email"]) {
      const known = await post(api, path, { email }, "192.0.2.81", cookie);
      const missing = await post(api, path, { email: unknown }, "192.0.2.81", cookie);
      expect(known.statusCode).toBe(200);
      expect(missing.statusCode).toBe(known.statusCode);
      expect(missing.json()).toEqual(known.json());
      expect(known.json()).toEqual({ status: true });
    }
    expect(api.mailbox.messages).toHaveLength(3);
    await signIn(api, email);
    expect((await readSession(api, cookie)).json()).not.toEqual({ session: null });
  });

  it("rejects invalid and expired links and consumes a reset token only once even across API instances", async () => {
    const api = await setup();
    const other = await setup();
    const email = newEmail();
    await post(api, "sign-up/email", { email, password });
    const expiredVerification = api.mailbox.token(email, "verification");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_601_000);
    const expired = await post(api, "verify-email", { token: expiredVerification });
    expect(expired.json()).toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    vi.useRealTimers();
    await post(api, "verify-email", { token: expiredVerification });
    for (const path of ["verify-email", "reset-password"]) {
      const result = await post(api, path, {
        token: "invalid-token-canary",
        ...(path === "reset-password" ? { newPassword } : {}),
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.json()).toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    }
    await post(api, "request-password-reset", { email });
    const expiredToken = api.mailbox.token(email, "reset");
    await api.database.db
      .update(authSchema.verification)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSchema.verification.identifier, `reset-password:${expiredToken}`));
    expect(
      (await post(api, "reset-password", { token: expiredToken, newPassword })).json(),
    ).toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await post(api, "request-password-reset", { email });
    const token = api.mailbox.token(email, "reset");
    const results = await Promise.all(
      [api, other].map((instance) => post(instance, "reset-password", { token, newPassword })),
    );
    expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([200, 400]);
    expect(
      (await post(api, "reset-password", { token, newPassword: password })).json(),
    ).toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await signIn(api, email, newPassword);
  });

  it("throttles resend and reset requests using the socket IP and returns a retry delay", async () => {
    const api = await setup();
    const email = newEmail();
    await post(api, "sign-up/email", { email, password });
    for (const path of ["send-verification-email", "request-password-reset"]) {
      for (let index = 0; index < 3; index++) {
        expect((await post(api, path, { email }, "192.0.2.88")).statusCode).toBe(200);
      }
      const count = api.mailbox.messages.length;
      const limited = await api.app.inject({
        method: "POST",
        url: `/api/auth/${path}`,
        payload: { email },
        remoteAddress: "192.0.2.88",
        headers: {
          origin: WEB_ORIGIN,
          [AUTH_IP_HEADER]: "203.0.113.1",
          "x-forwarded-for": "203.0.113.1",
        },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(api.mailbox.messages).toHaveLength(count);
      expect((await post(api, path, { email }, "192.0.2.89")).statusCode).toBe(200);
    }
  });

  it("reports mail failures, keeps signup committed without a session, and permits explicit retry", async () => {
    const api = await setup();
    const email = newEmail();
    api.mailbox.failure = true;
    const failed = await post(api, "sign-up/email", { email, password });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: "AUTH_EMAIL_UNAVAILABLE" });
    expect(failed.headers["set-cookie"]).toBeUndefined();
    expect(api.mailbox.messages).toHaveLength(0);
    expect(await api.database.db.$count(authSchema.user, eq(authSchema.user.email, email))).toBe(1);
    for (const path of ["send-verification-email", "request-password-reset"]) {
      const response = await post(api, path, { email }, "192.0.2.83");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "AUTH_EMAIL_UNAVAILABLE" });
      expect(response.body).not.toContain("smtp-password-and-token-secret-canary");
    }
    const parallel = await Promise.all([
      post(api, "request-password-reset", { email }, "192.0.2.85"),
      post(api, "request-password-reset", { email: newEmail() }, "192.0.2.86"),
    ]);
    expect(parallel.map(({ statusCode }) => statusCode)).toEqual([503, 503]);
    for (const response of parallel) {
      expect(response.json()).toMatchObject({ code: "AUTH_EMAIL_UNAVAILABLE" });
    }
    expect(api.logs.join("")).not.toContain("smtp-password-and-token-secret-canary");
    api.mailbox.failure = false;
    expect((await post(api, "send-verification-email", { email }, "192.0.2.84")).statusCode).toBe(
      200,
    );
    await post(api, "verify-email", { token: api.mailbox.token(email, "verification") });
    await signIn(api, email);
    expect((await post(api, "request-password-reset", { email })).statusCode).toBe(200);
  });

  it.each([true, false])(
    "awaits reset submission and permits delivery retry (registered: %s)",
    async (registered) => {
      const api = await setup();
      const email = registered ? await registerVerified(api) : newEmail();
      const entered = Promise.withResolvers<void>();
      const submission = Promise.withResolvers<void>();
      const send = api.mailbox.send.bind(api.mailbox);
      const spy = vi.spyOn(api.mailbox, "send").mockImplementation(async (message) => {
        entered.resolve();
        await submission.promise;
        await send(message);
      });
      let settled = false;
      const pending = post(api, "request-password-reset", { email }).then((response) => {
        settled = true;
        return response;
      });
      await entered.promise;
      expect(settled).toBe(false);
      api.mailbox.failure = true;
      submission.resolve();
      const failed = await pending;
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({ code: "AUTH_EMAIL_UNAVAILABLE" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(failed.body).not.toContain("smtp-password-and-token-secret-canary");
      spy.mockRestore();
      api.mailbox.failure = false;
      const retried = await post(api, "request-password-reset", { email });
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual({ status: true });
      const token = api.mailbox.token(email, "reset");
      expect(await api.database.db.$count(authSchema.user, eq(authSchema.user.email, email))).toBe(
        registered ? 1 : 0,
      );
      expect(
        await api.database.db.$count(
          authSchema.verification,
          eq(authSchema.verification.identifier, `reset-password:${token}`),
        ),
      ).toBe(registered ? 1 : 0);
      if (!registered) {
        expect((await post(api, "reset-password", { token, newPassword })).json()).toMatchObject({
          code: "AUTH_INVALID_TOKEN",
        });
        await post(api, "sign-up/email", { email, password });
        expect((await post(api, "reset-password", { token, newPassword })).json()).toMatchObject({
          code: "AUTH_INVALID_TOKEN",
        });
      }
    },
  );

  it("does not submit fallback reset mail for rejected or throttled requests", async () => {
    const api = await setup();
    const email = newEmail();
    for (const request of [
      { headers: {}, payload: { email } },
      {
        headers: { origin: WEB_ORIGIN },
        payload: { email, redirectTo: "https://attacker.example" },
      },
      { headers: { origin: WEB_ORIGIN }, payload: { email: "invalid" } },
    ]) {
      const response = await api.app.inject({
        method: "POST",
        url: "/api/auth/request-password-reset",
        ...request,
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(api.mailbox.messages).toHaveLength(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await post(api, "request-password-reset", { email })).statusCode).toBe(200);
    }
    const limited = await post(api, "request-password-reset", { email });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(api.mailbox.messages).toHaveLength(3);
  });

  it("sends mail only after signup commits, uses fixed fragment destinations, and rejects redirects and forged fields", async () => {
    const api = await setup();
    const email = newEmail();
    const send = api.mailbox.send.bind(api.mailbox);
    vi.spyOn(api.mailbox, "send").mockImplementation(async (message) => {
      expect(await api.database.db.$count(authSchema.user, eq(authSchema.user.email, email))).toBe(
        1,
      );
      await send(message);
    });
    await post(api, "sign-up/email", { email, password });
    await post(api, "request-password-reset", { email });
    for (const [kind, path] of [
      ["verification", "/auth/verify-email"],
      ["reset", "/auth/reset-password"],
    ] as const) {
      const url = api.mailbox.link(email, kind);
      expect(url.origin).toBe(WEB_ORIGIN);
      expect(url.pathname).toBe(path);
      expect(url.search).toBe("");
      expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBeTruthy();
    }
    for (const [path, body] of [
      ["sign-up/email", { email, password, emailVerified: true }],
      ["sign-up/email", { email, password, name: "forged-public-name" }],
      ["sign-in/email", { email, password, callbackURL: "https://attacker.example" }],
      ["send-verification-email", { email, callbackURL: "//attacker.example" }],
      [
        "request-password-reset",
        { email, redirectTo: `${WEB_ORIGIN}/redirect?next=https://attacker.example` },
      ],
      [
        "verify-email",
        {
          token: api.mailbox.token(email, "verification"),
          callbackURL: "https://attacker.example",
        },
      ],
      ["reset-password", { token: "secret", newPassword, userId: "forged" }],
    ] as const) {
      const result = await post(api, path, body);
      expect(result.statusCode).toBe(400);
      expect(result.headers.location).toBeUndefined();
    }
    for (const path of [
      "sign-up/email",
      "sign-in/email",
      "send-verification-email",
      "request-password-reset",
      "verify-email",
      "reset-password",
    ]) {
      for (const origin of [undefined, "null", "https://attacker.example"]) {
        const response = await api.app.inject({
          method: "POST",
          url: `/api/auth/${path}`,
          payload: {},
          headers: origin ? { origin } : {},
        });
        expect(response.statusCode).toBe(403);
      }
    }
    for (const url of [
      "/api/auth/verify-email?token=secret",
      "/api/auth/reset-password/secret?callbackURL=https://attacker.example",
    ]) {
      const response = await api.app.inject({ url });
      expect(response.statusCode).toBe(404);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("validates passwords before consuming reset links and never treats a reset as email verification", async () => {
    const api = await setup();
    const email = newEmail();
    for (const value of ["short", "x".repeat(129)]) {
      expect((await post(api, "sign-up/email", { email, password: value })).statusCode).toBe(400);
    }
    expect(api.mailbox.messages).toHaveLength(0);
    await post(api, "sign-up/email", { email, password });
    await post(api, "request-password-reset", { email });
    const token = api.mailbox.token(email, "reset");
    expect((await post(api, "reset-password", { token, newPassword: "short" })).statusCode).toBe(
      400,
    );
    expect((await post(api, "reset-password", { token, newPassword })).statusCode).toBe(200);
    const before = await post(api, "sign-in/email", { email, password: newPassword });
    expect(before.json()).toMatchObject({ code: "AUTH_EMAIL_NOT_VERIFIED" });
    await post(api, "verify-email", { token: api.mailbox.token(email, "verification") });
    await signIn(api, email, newPassword);
  });
});
