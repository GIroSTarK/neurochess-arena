import { randomInt, randomUUID } from "node:crypto";

import {
  authAccounts,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications,
  createGameRepository,
  createProfileRepository,
} from "@neurochess/database";
import { eq, inArray, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { buildApp } from "../src/app.js";
import { createAccountAuth } from "../src/auth/service.js";
import { createGameService } from "../src/games/service.js";
import { createLoggerOptions } from "../src/logger.js";
import { createProfileService } from "../src/profiles/service.js";

import { createTestMailbox } from "./auth-mailbox.js";
import { createOAuthTransport, type OAuthProvider } from "./oauth-transport.js";

const environment = {
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "oauth-integration-fixture-secret-not-for-deployment",
  WEB_ORIGIN: "http://localhost:5173",
  GOOGLE_CLIENT_ID: "google-fixture-client",
  GOOGLE_CLIENT_SECRET: "google-secret-canary",
  GITHUB_CLIENT_ID: "github-fixture-client",
  GITHUB_CLIENT_SECRET: "github-secret-canary",
};
let database: ReturnType<typeof integrationDatabase>;
let app: Awaited<ReturnType<typeof buildApp>>;
let transport: ReturnType<typeof createOAuthTransport>;
let mailbox: ReturnType<typeof createTestMailbox>;
let ip: string;
let email: string;
const emails: string[] = [];
const states: string[] = [];
const logs: string[] = [];

beforeEach(async () => {
  database = integrationDatabase();
  mailbox = createTestMailbox();
  ip = `198.20.${randomInt(256)}.${randomInt(1, 255)}`;
  email = `${randomUUID()}@example.com`;
  emails.push(email);
  transport = createOAuthTransport();
  transport.profiles.google.sub = randomUUID();
  transport.profiles.google.email = email;
  transport.profiles.github.id = randomInt(1, 1_000_000_000);
  transport.setEmails([{ email, primary: true, verified: true }]);
  vi.stubGlobal("fetch", transport.fetch);
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
  await app.close();
  if (emails.length) {
    const users = await database.db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(inArray(authUsers.email, emails));
    if (users.length) {
      await database.db.delete(authVerifications).where(
        inArray(
          authVerifications.value,
          users.map((user) => user.id),
        ),
      );
    }
    await database.db.delete(authUsers).where(inArray(authUsers.email, emails.splice(0)));
  }
  if (states.length) {
    await database.db
      .delete(authVerifications)
      .where(inArray(authVerifications.identifier, states.splice(0)));
  }
  await database.db.delete(authRateLimits).where(like(authRateLimits.key, `${ip}|%`));
  await database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

async function start(provider: OAuthProvider, cookie?: string) {
  const response = await post("sign-in/social", { provider }, cookie);
  expect(response.statusCode).toBe(200);
  const url = new URL(response.json<{ url: string }>().url);
  expect(url.origin + url.pathname).toBe(
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://github.com/login/oauth/authorize",
  );
  expect(url.searchParams.get("redirect_uri")).toBe(
    `${environment.BETTER_AUTH_URL}/api/auth/callback/${provider}`,
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(new Set(url.searchParams.get("scope")?.split(" "))).toEqual(
    new Set(provider === "google" ? ["openid", "email", "profile"] : ["user:email"]),
  );
  expect(url.searchParams.get("access_type")).not.toBe("offline");
  expect(url.searchParams.get("include_granted_scopes")).not.toBe("true");
  const state = url.searchParams.get("state")!;
  expect(state).toBeTruthy();
  states.push(state);
  const stateCookie = response.cookies.find(({ name }) => name.endsWith(".state"));
  expect(stateCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  const code = `code-canary-${randomUUID()}`;
  transport.grant(provider, url, code);
  return {
    provider,
    state,
    code,
    cookie: response.cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
  };
}

function callback(
  flow: Awaited<ReturnType<typeof start>>,
  patch: Record<string, string | undefined> = {},
  cookie: string | undefined = flow.cookie,
) {
  const values: Record<string, string | undefined> = {
    state: flow.state,
    code: flow.code,
    ...patch,
  };
  const query = new URLSearchParams(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return app.inject({
    url: `/api/auth/callback/${flow.provider}?${query}`,
    remoteAddress: ip,
    headers: {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      ...(cookie ? { cookie } : {}),
    },
  });
}

function session(cookie: string) {
  return app.inject({ url: "/api/auth/get-session", remoteAddress: ip, headers: { cookie } });
}

function sessionCookie(response: { cookies: { name: string; value: string }[] }) {
  return response.cookies
    .filter(({ name }) => name.endsWith(".session_token"))
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

function expectFailure(response: Awaited<ReturnType<typeof callback>>, code = "AUTH_OAUTH_FAILED") {
  expect(response.statusCode).toBe(303);
  expect(response.headers.location).toBe(
    `${environment.WEB_ORIGIN}/?auth=oauth-error&code=${code}`,
  );
  expect(sessionCookie(response)).toBe("");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}

describe.each(["google", "github"] as const)(
  "%s OAuth through the real auth integration",
  (provider) => {
    it("requires chosen-username onboarding, supports renames and preserves avatar removal on returning sign-in", async () => {
      const cookie = sessionCookie(await callback(await start(provider)));
      const read = (value = cookie) => app.inject({ url: "/profile", headers: { cookie: value } });
      const update = (url: string, payload: object) =>
        app.inject({
          method: "POST",
          url,
          payload,
          headers: { cookie, origin: environment.WEB_ORIGIN },
        });
      const initial = await read();
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({
        username: null,
        completed: false,
        avatar: { source: provider, initials: "?" },
      });
      const principal = (await createAccountAuth(database, environment, mailbox).resolve(
        new Headers({ cookie }),
      ))!;
      const games = createGameService(createGameRepository(database), {
        nodeEnv: "test",
        sandboxEnabled: true,
      });
      await expect(games.unfinishedGame(principal)).rejects.toMatchObject({
        code: "PROFILE_REQUIRED",
      });
      const username = `OAuth_${randomUUID().slice(0, 8)}`;
      expect((await update("/profile/onboarding", { username })).json()).toMatchObject({
        username,
        completed: true,
        avatar: { source: provider, initials: "OA" },
      });
      expect(await games.unfinishedGame(principal)).toEqual({ game: null });
      const renamed = `Renamed_${randomUUID().slice(0, 8)}`;
      expect((await update("/profile", { username: renamed, avatar: "remove" })).json()).toEqual({
        username: renamed,
        completed: true,
        avatar: { source: "initials", initials: "RE" },
      });
      expect((await post("sign-out", {}, cookie)).statusCode).toBe(200);
      const returning = sessionCookie(await callback(await start(provider)));
      const response = await read(returning);
      expect(response.json()).toEqual({
        username: renamed,
        completed: true,
        avatar: { source: "initials", initials: "RE" },
      });
      expect(response.body).not.toContain(email);
      expect(response.body).not.toContain(principal.userId);
      expect((await session(returning)).body).not.toContain(renamed);
      expect(
        (
          await database.db
            .select({ image: authUsers.image })
            .from(authUsers)
            .where(eq(authUsers.id, principal.userId))
        )[0],
      ).toEqual({ image: null });
    });

    it("enforces a single owner for a provider subject in PostgreSQL", async () => {
      const first = await callback(await start(provider));
      const owner = (await session(sessionCookie(first))).json<{ user: { id: string } }>().user.id;
      const [account] = await database.db
        .select()
        .from(authAccounts)
        .where(eq(authAccounts.userId, owner));
      const otherEmail = `${randomUUID()}@example.com`;
      emails.push(otherEmail);
      await post("sign-up/email", { email: otherEmail, password: "other-account-password" });
      const [other] = await database.db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, otherEmail));
      await expect(
        database.db.insert(authAccounts).values({
          accountId: account!.accountId,
          providerId: provider,
          userId: other!.id,
        }),
      ).rejects.toThrow();
    });

    it("handles concurrent first sign-ins without duplicate identities or partial users", async () => {
      const first = await start(provider);
      const second = await start(provider);
      const results = await Promise.all([callback(first), callback(second)]);
      expect(results.some((result) => sessionCookie(result))).toBe(true);
      const users = await database.db.select().from(authUsers).where(eq(authUsers.email, email));
      expect(users).toHaveLength(1);
      expect(await database.db.$count(authAccounts, eq(authAccounts.userId, users[0]!.id))).toBe(1);
      for (const response of results) {
        const cookie = sessionCookie(response);
        if (cookie) {
          expect((await session(cookie)).json()).toMatchObject({ user: { id: users[0]!.id } });
        } else expectFailure(response);
      }
    });

    it("signs in, persists only identity and safe initial avatar, and signs out", async () => {
      const flow = await start(provider);
      const response = await callback(
        flow,
        provider === "google"
          ? {
              scope: "openid email profile",
              authuser: "0",
              prompt: "consent",
              iss: "https://accounts.google.com",
            }
          : {},
      );
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe(`${environment.WEB_ORIGIN}/?auth=signed-in`);
      const cookie = sessionCookie(response);
      const projected = (await session(cookie)).json<{
        user: { id: string; email: string; emailVerified: boolean };
      }>();
      expect(projected.user).toMatchObject({ email, emailVerified: true });
      const [user] = await database.db
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, projected.user.id));
      expect(user).toMatchObject({
        name: "",
        image:
          provider === "google"
            ? transport.profiles.google.picture
            : transport.profiles.github.avatar_url,
      });
      const [account] = await database.db
        .select()
        .from(authAccounts)
        .where(eq(authAccounts.userId, projected.user.id));
      expect(account).toMatchObject({
        providerId: provider,
        accessToken: null,
        refreshToken: null,
        idToken: null,
        scope: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      });
      expect(mailbox.messages).toHaveLength(0);
      expect(response.cookies.some(({ name }) => name.includes("account_data"))).toBe(false);
      expect(
        await database.db.$count(authVerifications, eq(authVerifications.identifier, flow.state)),
      ).toBe(0);
      expect((await post("sign-out", {}, cookie)).statusCode).toBe(200);
      expect((await session(cookie)).json()).toBeNull();
      for (const secret of [
        flow.code,
        flow.state,
        cookie,
        email,
        "access-token-canary",
        "refresh-token-canary",
        "secret-canary",
        "untrusted-name-canary",
      ]) {
        expect(logs.join("")).not.toContain(secret);
        expect(response.body + (response.headers.location ?? "")).not.toContain(secret);
      }
    });

    it("rejects mismatched, missing, tampered and expired state before dispatch, and rejects replay", async () => {
      const flow = await start(provider);
      for (const [patch, cookie] of [
        [{ state: "attacker-state" }, flow.cookie],
        [{ state: undefined }, flow.cookie],
        [{}, ""],
        [{}, `${flow.cookie}tampered`],
      ] as const) {
        expectFailure(await callback(flow, patch, cookie));
      }
      expect(transport.fetch).not.toHaveBeenCalled();
      const response = await callback(flow);
      expect(response.headers.location).toBe(`${environment.WEB_ORIGIN}/?auth=signed-in`);
      const calls = transport.fetch.mock.calls.length;
      expectFailure(await callback(flow));
      expect(transport.fetch).toHaveBeenCalledTimes(calls);
      const expired = await start(provider);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expectFailure(await callback(expired));
      expect(transport.fetch).toHaveBeenCalledTimes(calls);
    });

    it("does not exchange a code at a different provider than the initiating flow", async () => {
      const flow = await start(provider);
      expectFailure(
        await callback({ ...flow, provider: provider === "google" ? "github" : "google" }),
      );
      expect(transport.fetch).not.toHaveBeenCalled();
    });

    it("omits unsafe avatars and rejects a mismatched issuer", async () => {
      const imageKey = provider === "google" ? "picture" : "avatar_url";
      transport.profiles[provider][imageKey] =
        "https://avatars.githubusercontent.com.attacker.example/private?token=avatar-secret-canary";
      const flow = await start(provider);
      expectFailure(await callback(flow, { iss: "https://attacker.example" }));
      expect(transport.fetch).not.toHaveBeenCalled();
      const response = await callback(await start(provider));
      const id = (await session(sessionCookie(response))).json<{ user: { id: string } }>().user.id;
      const [user] = await database.db.select().from(authUsers).where(eq(authUsers.id, id));
      expect(user?.image).toBeNull();
      expect(logs.join("")).not.toContain("avatar-secret-canary");
    });

    it("sanitizes canceled consent, provider prose, transport failures and invalid codes", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const canceled = await start(provider);
      expectFailure(
        await callback(canceled, {
          code: undefined,
          error: "access_denied",
          error_description: "https://attacker.example/?token=secret-canary",
          error_uri: "https://attacker.example/?secret=error-uri-canary",
        }),
        "AUTH_OAUTH_CANCELLED",
      );
      expect(transport.fetch).not.toHaveBeenCalled();
      expectFailure(await callback(await start(provider), { code: "invalid-code-canary" }));
      transport.failures.set(
        provider === "google"
          ? "https://oauth2.googleapis.com/token"
          : "https://github.com/login/oauth/access_token",
        new Error("transport-secret-canary"),
      );
      expectFailure(await callback(await start(provider)));
      expect(logs.join("")).not.toContain("canary");
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(await database.db.$count(authUsers, eq(authUsers.email, email))).toBe(0);
    });

    it("requires valid verified email and immutable subject without creating a partial account", async () => {
      for (const fault of [
        "missing-email",
        "unverified-email",
        "invalid-email",
        "missing-subject",
      ]) {
        if (provider === "google") {
          transport.profiles.google.email =
            fault === "missing-email"
              ? undefined
              : fault === "invalid-email"
                ? "not-an-email"
                : email;
          transport.profiles.google.email_verified = fault !== "unverified-email";
          transport.profiles.google.sub =
            fault === "missing-subject" ? undefined : "google-safe-subject";
        } else {
          transport.setEmails(
            fault === "missing-email"
              ? []
              : [
                  {
                    email: fault === "invalid-email" ? "not-an-email" : email,
                    verified: fault !== "unverified-email",
                    primary: true,
                  },
                ],
          );
          transport.profiles.github.id = fault === "missing-subject" ? undefined : 12345678;
        }
        const result = await callback(await start(provider));
        expectFailure(
          result,
          fault === "missing-subject" ? "AUTH_OAUTH_FAILED" : "AUTH_OAUTH_EMAIL_UNAVAILABLE",
        );
        expect(await database.db.$count(authUsers, eq(authUsers.email, email))).toBe(0);
      }
    });

    it("returns to the bound account after a verified provider email change and does not restore a removed avatar", async () => {
      const first = await callback(await start(provider));
      const original = (await session(sessionCookie(first))).json<{ user: { id: string } }>().user
        .id;
      const changedEmail = `${randomUUID()}@example.com`;
      emails.push(changedEmail);
      await post("sign-up/email", { email: changedEmail, password: "existing-password-fixture" });
      if (provider === "google") transport.profiles.google.email = changedEmail;
      else transport.setEmails([{ email: changedEmail, verified: true, primary: true }]);
      await database.db.update(authUsers).set({ image: null }).where(eq(authUsers.id, original));
      const again = await callback(await start(provider));
      expect((await session(sessionCookie(again))).json()).toMatchObject({
        user: { id: original, email },
      });
      const [user] = await database.db.select().from(authUsers).where(eq(authUsers.id, original));
      expect(user?.image).toBeNull();
      expect(await database.db.$count(authAccounts, eq(authAccounts.userId, original))).toBe(1);
    });

    it("does not let email recovery or registration add a password to an OAuth-only account", async () => {
      const response = await callback(await start(provider));
      const id = (await session(sessionCookie(response))).json<{ user: { id: string } }>().user.id;
      const absent = await post("request-password-reset", { email: `${randomUUID()}@example.com` });
      const reset = await post("request-password-reset", { email });
      expect(reset.json()).toEqual(absent.json());
      expect(mailbox.messages).toHaveLength(0);
      const registered = await post("sign-up/email", {
        email,
        password: "unwanted-password-fixture",
      });
      expect(registered.json()).toMatchObject({ status: "accepted" });
      const token = `reset-fixture-${randomUUID()}`;
      states.push(`reset-password:${token}`);
      await database.db.insert(authVerifications).values({
        identifier: `reset-password:${token}`,
        value: id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const completion = await post("reset-password", {
        token,
        newPassword: "unwanted-password-fixture",
      });
      expect(completion.statusCode).toBe(400);
      expect(completion.json()).toMatchObject({ code: "AUTH_INVALID_TOKEN" });
      expect(await database.db.$count(authAccounts, eq(authAccounts.userId, id))).toBe(1);
      expect((await session(sessionCookie(response))).json()).toMatchObject({ user: { id } });
    });

    it("does not attach a new provider identity to an existing email or signed-in account", async () => {
      await post("sign-up/email", { email, password: "existing-password-fixture" });
      const link = mailbox.link();
      await app.inject({ url: `${link.pathname}${link.search}`, remoteAddress: ip });
      const passwordSignIn = await post("sign-in/email", {
        email,
        password: "existing-password-fixture",
      });
      const cookie = sessionCookie(passwordSignIn);
      const [existing] = await database.db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, email));
      const sessionsBefore = await database.db.$count(
        authSessions,
        eq(authSessions.userId, existing!.id),
      );
      expectFailure(await callback(await start(provider, cookie), {}, cookie), "AUTH_OAUTH_FAILED");
      expectFailure(await callback(await start(provider, cookie)), "AUTH_OAUTH_ACCOUNT_CONFLICT");
      expect(await database.db.$count(authSessions, eq(authSessions.userId, existing!.id))).toBe(
        sessionsBefore,
      );
      expect(await database.db.$count(authAccounts, eq(authAccounts.userId, existing!.id))).toBe(1);
      for (const path of [
        "link-social",
        "unlink-account",
        "get-access-token",
        "refresh-token",
        "list-accounts",
        "update-user",
        "delete-user",
      ]) {
        expect((await post(path, { provider }, cookie)).statusCode).toBe(404);
      }
    });
  },
);

describe("OAuth boundary and linking policy", () => {
  it("keeps an unconfigured provider unavailable without disabling the configured provider", async () => {
    await app.close();
    app = await buildApp({
      readiness: database,
      webOrigin: environment.WEB_ORIGIN,
      auth: createAccountAuth(database, {
        ...environment,
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: undefined,
      }),
    });
    expect((await post("sign-in/social", { provider: "github" })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/auth/callback/github?code=canary&state=canary",
          remoteAddress: ip,
        })
      ).statusCode,
    ).toBe(404);
    expect((await callback(await start("google"))).headers.location).toBe(
      `${environment.WEB_ORIGIN}/?auth=signed-in`,
    );
  });

  it("keeps strict JSON/exact-Origin initiation and rejects client-controlled auth policy", async () => {
    for (const payload of [
      { provider: "unknown" },
      { provider: "google", callbackURL: "https://attacker.example" },
      { provider: "google", errorCallbackURL: "https://attacker.example" },
      { provider: "google", newUserCallbackURL: environment.WEB_ORIGIN },
      { provider: "google", scopes: ["drive"] },
      { provider: "google", idToken: { token: "canary" } },
      { provider: "github", additionalData: { link: { userId: randomUUID() } } },
      { provider: "github", additionalParams: { redirect_uri: "https://attacker.example" } },
      { provider: "google", userId: randomUUID() },
    ]) {
      expect((await post("sign-in/social", payload)).statusCode).toBe(400);
    }
    for (const origin of [undefined, "https://attacker.example", "null"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/social",
        remoteAddress: ip,
        headers: origin ? { origin } : {},
        payload: { provider: "google" },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/sign-in/social",
          remoteAddress: ip,
          headers: {
            origin: environment.WEB_ORIGIN,
            "content-type": "application/x-www-form-urlencoded",
          },
          payload: "provider=google",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/callback/google",
          remoteAddress: ip,
          headers: { origin: environment.WEB_ORIGIN },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("rate limits initiation by socket IP and does not accept forwarding-header bypasses", async () => {
    for (let index = 0; index < 10; index++) await start("google");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      remoteAddress: ip,
      headers: { origin: environment.WEB_ORIGIN, "x-forwarded-for": "203.0.113.123" },
      payload: { provider: "google" },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("never merges providers with a matching email, including an unverified password account", async () => {
    await post("sign-up/email", { email, password: "unverified-password-fixture" });
    expectFailure(await callback(await start("google")), "AUTH_OAUTH_ACCOUNT_CONFLICT");
    expectFailure(await callback(await start("github")), "AUTH_OAUTH_ACCOUNT_CONFLICT");
    await database.db.delete(authUsers).where(eq(authUsers.email, email));
    const google = await callback(await start("google"));
    expectFailure(
      await callback(await start("github", sessionCookie(google))),
      "AUTH_OAUTH_ACCOUNT_CONFLICT",
    );
    const [user] = await database.db.select().from(authUsers).where(eq(authUsers.email, email));
    expect(await database.db.$count(authAccounts, eq(authAccounts.userId, user!.id))).toBe(1);
  });

  it("rejects duplicate callback parameters and unexpected fields, including injected link state", async () => {
    const flow = await start("google");
    for (const suffix of [
      "&state=other",
      "&code=other",
      "&link=forged",
      "&callbackURL=https://attacker.example",
    ]) {
      const response = await app.inject({
        url: `/api/auth/callback/google?state=${flow.state}&code=${flow.code}${suffix}`,
        remoteAddress: ip,
        headers: { cookie: flow.cookie },
      });
      expectFailure(response);
    }
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});
