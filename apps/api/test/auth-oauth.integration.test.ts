import { randomInt, randomUUID } from "node:crypto";

import {
  type AuthOAuthProvider,
  authOAuthStartResponseSchema,
  profileResponseSchema,
} from "@neurochess/contracts";
import { authSchema } from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { AUTH_COOKIE_NAME, type AuthService, createAuth } from "../src/auth/service.js";
import { createLoggerOptions } from "../src/logger.js";

import { aiMatch } from "./ai-turn-helpers.js";
import { AUTH_ENVIRONMENT, fixtureAuth, registerFixture } from "./auth-helpers.js";
import { ApiHarness, createSandbox, type TestApi, WEB_ORIGIN } from "./helpers.js";
import { OAUTH_ENVIRONMENT, type OAuthGrant, TestOAuthTransport } from "./oauth-transport.js";

const harness = new ApiHarness();
const emails: string[] = [];
const states: string[] = [];
let requestNumber = 0;
function remoteAddress() {
  requestNumber++;
  return `198.18.${Math.floor(requestNumber / 256)}.${requestNumber % 256}`;
}
afterEach(async () => {
  await harness.dispose();
  const database = integrationDatabase();
  try {
    if (emails.length) {
      await database.db.delete(authSchema.user).where(inArray(authSchema.user.email, emails));
    }
    if (states.length) {
      await database.db
        .delete(authSchema.verification)
        .where(inArray(authSchema.verification.identifier, states));
    }
  } finally {
    emails.length = 0;
    states.length = 0;
    await database.close();
    vi.restoreAllMocks();
  }
});

async function setup() {
  const transport = new TestOAuthTransport();
  const logs: string[] = [];
  let auth!: AuthService;
  const api = await harness.createApi({
    auth(database) {
      auth = createAuth(
        database,
        { ...AUTH_ENVIRONMENT, ...OAUTH_ENVIRONMENT },
        { oauthFetch: transport.fetch },
      );
      return auth;
    },
    logger: {
      ...createLoggerOptions("info"),
      stream: { write: (chunk: string) => logs.push(chunk) },
    },
  });
  return {
    ...api,
    auth,
    transport,
    logs,
    async register() {
      const account = await registerFixture(fixtureAuth(api.database));
      emails.push(account.email);
      await api.database.db
        .update(authSchema.user)
        .set({ emailVerified: true })
        .where(eq(authSchema.user.id, account.userId));
      return account;
    },
  };
}
type OAuthApi = Awaited<ReturnType<typeof setup>>;

function post(api: TestApi, path: string, payload: Record<string, unknown>, cookie?: string) {
  return api.app.inject({
    method: "POST",
    url: `/api/auth${path}`,
    payload,
    remoteAddress: remoteAddress(),
    headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
  });
}
async function start(api: OAuthApi, provider: AuthOAuthProvider, cookie?: string, link = false) {
  const response = await post(api, link ? "/link-social" : "/sign-in/social", { provider }, cookie);
  expect(response.statusCode).toBe(200);
  const authorization = new URL(authOAuthStartResponseSchema.parse(response.json()).url);
  const state = authorization.searchParams.get("state")!;
  states.push(state);
  const stateCookie = response.cookies.find((value) => value.name.endsWith(".state"));
  expect(
    Boolean(stateCookie?.httpOnly && stateCookie.secure && stateCookie.sameSite === "Lax"),
  ).toBe(true);
  return {
    authorization,
    state,
    cookie: `${stateCookie!.name}=${stateCookie!.value}${cookie ? `; ${cookie}` : ""}`,
    provider,
  };
}
type Flow = Awaited<ReturnType<typeof start>>;

function identity(email = `${randomUUID()}@example.test`) {
  emails.push(email.toLowerCase());
  return { email, subject: randomInt(1, 2_000_000_000) };
}
function callback(
  api: OAuthApi,
  flow: Flow,
  input: Pick<OAuthGrant, "email" | "subject"> & Partial<OAuthGrant>,
) {
  const code = api.transport.grant({
    ...input,
    provider: flow.provider,
    authorization: flow.authorization,
  });
  return api.app.inject({
    method: "GET",
    remoteAddress: remoteAddress(),
    url: `/api/auth/callback/${flow.provider}?${new URLSearchParams({ code, state: flow.state })}`,
    headers: { cookie: flow.cookie, "sec-fetch-site": "cross-site" },
  });
}
async function sessionUser(api: TestApi, response: Awaited<ReturnType<typeof callback>>) {
  const cookie = response.cookies.find((item) => item.name === AUTH_COOKIE_NAME);
  expect(Boolean(cookie)).toBe(true);
  const session = await api.app.inject({
    method: "GET",
    url: "/api/auth/get-session",
    headers: { cookie: `${cookie!.name}=${cookie!.value}` },
  });
  return session.json<{ session: { user: { id: string; email: string } } }>().session.user;
}
function failed(response: Awaited<ReturnType<typeof callback>>, code = "AUTH_OAUTH_FAILED") {
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe(`${WEB_ORIGIN}/auth/complete#error=${code}`);
  expect(response.cookies.some((cookie) => cookie.name === AUTH_COOKIE_NAME && cookie.value)).toBe(
    false,
  );
}

describe("Google and GitHub OAuth through Better Auth and PostgreSQL", () => {
  it.each(["google", "github"] as const)(
    "completes the same profile onboarding for %s and preserves avatar removal on returning sign-in",
    async (provider) => {
      const api = await setup();
      const person = identity();
      const signedIn = await callback(api, await start(api, provider), person);
      const sessionCookie = (response: typeof signedIn) => {
        const item = response.cookies.find((entry) => entry.name === AUTH_COOKIE_NAME)!;
        return `${item.name}=${encodeURIComponent(item.value)}`;
      };
      const cookie = sessionCookie(signedIn);
      const update = (payload: object, activeCookie = cookie, path = "/api/profile") =>
        api.app.inject({
          method: "POST",
          url: path,
          payload,
          headers: { origin: WEB_ORIGIN, cookie: activeCookie },
        });
      const read = async (activeCookie = cookie) => {
        const response = await api.app.inject({
          url: "/api/profile",
          headers: { cookie: activeCookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(person.email);
        expect(response.body).not.toContain("private-provider-name-canary");
        return profileResponseSchema.parse(response.json());
      };
      const initial = await read();
      expect(initial).toMatchObject({
        username: null,
        onboardingRequired: true,
        avatar: { source: provider, initials: null },
      });
      const blocked = await api.app.inject({
        method: "POST",
        url: "/games",
        payload: aiMatch,
        headers: { cookie, origin: WEB_ORIGIN },
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ code: "PROFILE_REQUIRED" });
      const username = "OAuth_" + randomUUID().replaceAll("-", "").slice(0, 18);
      expect((await update({ username }, cookie, "/api/profile/onboarding")).statusCode).toBe(200);
      expect((await update({ avatar: "initials" })).statusCode).toBe(200);
      expect(await read()).toMatchObject({
        username,
        onboardingRequired: false,
        avatar: { source: "initials", initials: "OA" },
      });
      await post(api, "/sign-out", {}, cookie);
      const returned = await callback(api, await start(api, provider), person);
      const returningCookie = sessionCookie(returned);
      expect(await read(returningCookie)).toMatchObject({
        username,
        avatar: { source: "initials", initials: "OA" },
      });
      expect((await update({ avatar: "provider" }, returningCookie)).statusCode).toBe(200);
      expect((await read(returningCookie)).avatar).toMatchObject({
        source: provider,
        url: initial.providerAvatar!.url,
      });
      const changed = "Changed_" + randomUUID().replaceAll("-", "").slice(0, 16);
      expect((await update({ username: changed }, returningCookie)).statusCode).toBe(200);
      expect(await read(returningCookie)).toMatchObject({
        username: changed,
        avatar: { initials: "CH" },
      });
    },
  );

  it("enforces provider/subject uniqueness across concurrent account owners in PostgreSQL", async () => {
    const api = await setup();
    const owners = await Promise.all([api.register(), api.register()]);
    const subject = randomUUID();
    const results = await Promise.allSettled(
      owners.map((owner) =>
        api.database.db.insert(authSchema.account).values({
          id: randomUUID(),
          providerId: "google",
          accountId: subject,
          userId: owner.userId,
          updatedAt: new Date(),
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      await api.database.db.$count(authSchema.account, eq(authSchema.account.accountId, subject)),
    ).toBe(1);
    await api.database.db.insert(authSchema.account).values({
      id: randomUUID(),
      providerId: "github",
      accountId: subject,
      userId: owners[1].userId,
      updatedAt: new Date(),
    });
  });

  it("does not merge Google and GitHub accounts on email and limits starts using the socket IP", async () => {
    const api = await setup();
    const person = identity();
    const google = await sessionUser(api, await callback(api, await start(api, "google"), person));
    failed(await callback(api, await start(api, "github"), person), "AUTH_OAUTH_CONFLICT");
    expect(
      await api.database.db.$count(authSchema.account, eq(authSchema.account.userId, google.id)),
    ).toBe(1);
    const address = remoteAddress();
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await api.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/social",
        payload: { provider: "google" },
        remoteAddress: address,
        headers: {
          origin: WEB_ORIGIN,
          "x-forwarded-for": remoteAddress(),
          "x-neurochess-client-ip": remoteAddress(),
        },
      });
      if (attempt < 10) {
        expect(response.statusCode).toBe(200);
        states.push(new URL(response.json<{ url: string }>().url).searchParams.get("state")!);
      } else {
        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBeDefined();
      }
    }
  });

  it("rejects an issuer mismatch before token exchange and discards unsafe provider profile content", async () => {
    const api = await setup();
    const flow = await start(api, "google");
    failed(
      await api.app.inject({
        method: "GET",
        url: `/api/auth/callback/google?${new URLSearchParams({ state: flow.state, code: "issuer-code-canary", iss: "https://attacker.example" })}`,
        headers: { cookie: flow.cookie },
      }),
    );
    expect(api.transport.exchanges).toBe(0);
    const person = identity();
    const user = await sessionUser(
      api,
      await callback(api, await start(api, "google"), {
        ...person,
        profile: {
          sub: String(person.subject),
          email: person.email.toUpperCase(),
          email_verified: true,
          name: "<script>profile-canary</script>",
          picture: "javascript:alert(1)",
          arbitrary: "private-profile-canary",
        },
      }),
    );
    const [row] = await api.database.db
      .select()
      .from(authSchema.user)
      .where(eq(authSchema.user.id, user.id));
    expect(row).toMatchObject({ name: "", image: null, email: person.email });
  });

  it.each(["google", "github"] as const)(
    "signs in %s with scoped PKCE, a verified identity, and no retained provider secrets",
    async (provider) => {
      const api = await setup();
      const person = identity();
      const flow = await start(api, provider);
      expect(flow.authorization.searchParams.get("scope")?.split(" ").sort()).toEqual(
        provider === "google" ? ["email", "openid", "profile"] : ["user:email"],
      );
      expect(flow.authorization.searchParams.get("redirect_uri")).toBe(
        `${AUTH_ENVIRONMENT.BETTER_AUTH_URL}/api/auth/callback/${provider}`,
      );
      expect(flow.authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(flow.authorization.searchParams.get("access_type")).not.toBe("offline");
      const response = await callback(api, flow, person);
      expect(response.headers.location).toBe(`${WEB_ORIGIN}/auth/complete#status=signed-in`);
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cache-control"]).toBe("no-store");
      const user = await sessionUser(api, response);
      expect(user.email).toBe(person.email);
      expect(api.transport.pkceVerified).toBe(1);
      const [record] = await api.database.db
        .select()
        .from(authSchema.user)
        .where(eq(authSchema.user.id, user.id));
      expect(record).toMatchObject({ name: "", emailVerified: true });
      const [account] = await api.database.db
        .select()
        .from(authSchema.account)
        .where(eq(authSchema.account.userId, user.id));
      expect(account).toMatchObject({
        providerId: provider,
        accountId: String(person.subject),
        accessToken: null,
        refreshToken: null,
        idToken: null,
        scope: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      });
      const stored = JSON.stringify({ record, account });
      for (const canary of [
        "access-token-canary",
        "refresh-token-canary",
        "id-token-canary",
        "private-provider-name",
        "private-login",
        "private-secondary",
      ]) {
        expect(stored.includes(canary)).toBe(false);
      }
      expect(
        await api.database.db.$count(
          authSchema.verification,
          eq(authSchema.verification.identifier, flow.state),
        ),
      ).toBe(0);
    },
  );

  it.each(["google", "github"] as const)(
    "uses the stable %s subject after verified email changes and preserves local profile choices",
    async (provider) => {
      const api = await setup();
      const person = identity();
      const first = await sessionUser(api, await callback(api, await start(api, provider), person));
      await api.database.db
        .update(authSchema.user)
        .set({ name: "Chosen name", image: null })
        .where(eq(authSchema.user.id, first.id));
      const another = await api.register();
      const returning = await sessionUser(
        api,
        await callback(api, await start(api, provider), { ...person, email: another.email }),
      );
      expect(returning).toEqual(first);
      const [stored] = await api.database.db
        .select()
        .from(authSchema.user)
        .where(eq(authSchema.user.id, first.id));
      expect(stored).toMatchObject({ name: "Chosen name", image: null, email: person.email });
      expect(
        await api.database.db.$count(
          authSchema.account,
          eq(authSchema.account.userId, another.userId),
        ),
      ).toBe(1);
    },
  );

  it.each(["google", "github"] as const)(
    "rejects %s email conflicts, permits explicit fresh same-email linking, and preserves the password account",
    async (provider) => {
      const api = await setup();
      const account = await api.register();
      const person = identity(account.email);
      failed(
        await callback(api, await start(api, provider, account.cookie), person),
        "AUTH_OAUTH_CONFLICT",
      );
      expect(
        await api.database.db.$count(
          authSchema.account,
          eq(authSchema.account.userId, account.userId),
        ),
      ).toBe(1);
      const linked = await callback(api, await start(api, provider, account.cookie, true), person);
      expect(linked.headers.location).toBe(`${WEB_ORIGIN}/auth/complete#status=linked`);
      expect(linked.cookies.some((cookie) => cookie.name === AUTH_COOKIE_NAME)).toBe(false);
      const user = await sessionUser(api, await callback(api, await start(api, provider), person));
      expect(user.id).toBe(account.userId);
      const again = await callback(api, await start(api, provider, account.cookie, true), person);
      expect(again.headers.location).toBe(`${WEB_ORIGIN}/auth/complete#status=linked`);
      const rows = await api.database.db
        .select()
        .from(authSchema.account)
        .where(eq(authSchema.account.userId, account.userId));
      expect(rows).toHaveLength(2);
      expect(Boolean(rows.find((row) => row.providerId === "credential")?.password)).toBe(true);
      expect(rows.find((row) => row.providerId === provider)).toMatchObject({
        accessToken: null,
        refreshToken: null,
        idToken: null,
      });
    },
  );

  it("never links different emails or a provider identity already owned by another account", async () => {
    const api = await setup();
    const owner = await api.register();
    const other = await api.register();
    const person = identity(owner.email);
    expect(
      (await callback(api, await start(api, "google", owner.cookie, true), person)).headers
        .location,
    ).toContain("status=linked");
    failed(
      await callback(api, await start(api, "google", other.cookie, true), person),
      "AUTH_OAUTH_CONFLICT",
    );
    failed(
      await callback(api, await start(api, "google", other.cookie, true), {
        ...person,
        email: other.email,
      }),
      "AUTH_OAUTH_CONFLICT",
    );
    expect(
      await api.database.db.$count(authSchema.account, eq(authSchema.account.userId, other.userId)),
    ).toBe(1);
  });

  it.each(["google", "github"] as const)(
    "rejects forged, absent, cross-browser, expired, cross-provider, and replayed %s state",
    async (provider) => {
      const api = await setup();
      const person = identity();
      const flow = await start(api, provider);
      failed(await callback(api, { ...flow, state: "forged-state-canary" }, person));
      failed(await callback(api, { ...flow, cookie: "" }, person));
      const other = await start(api, provider);
      failed(await callback(api, { ...flow, cookie: other.cookie }, person));
      const missing = await api.app.inject({
        method: "GET",
        url: `/api/auth/callback/${provider}?code=missing-state-code-canary`,
        headers: { cookie: flow.cookie },
      });
      failed(missing);
      expect(api.transport.exchanges).toBe(0);
      const [verification] = await api.database.db
        .select()
        .from(authSchema.verification)
        .where(eq(authSchema.verification.identifier, flow.state));
      const value = JSON.parse(verification!.value) as Record<string, unknown>;
      await api.database.db
        .update(authSchema.verification)
        .set({
          expiresAt: new Date(Date.now() - 1000),
          value: JSON.stringify({ ...value, expiresAt: Date.now() - 1000 }),
        })
        .where(eq(authSchema.verification.identifier, flow.state));
      failed(await callback(api, flow, person));
      const mismatch = await start(api, provider);
      failed(
        await callback(
          api,
          { ...mismatch, provider: provider === "google" ? "github" : "google" },
          person,
        ),
      );
      expect(api.transport.exchanges).toBe(0);
      const valid = await start(api, provider);
      expect((await callback(api, valid, person)).headers.location).toContain("status=signed-in");
      failed(await callback(api, valid, person));
      expect(api.transport.exchanges).toBe(1);
    },
  );

  it.each(["google", "github"] as const)(
    "rejects missing/unverified/malformed %s identity on signup, sign-in, and linking",
    async (provider) => {
      const api = await setup();
      const person = identity();
      const user = await sessionUser(api, await callback(api, await start(api, provider), person));
      const bad: Partial<OAuthGrant>[] =
        provider === "google"
          ? [
              {
                profile: {
                  sub: String(person.subject),
                  email: person.email,
                  email_verified: false,
                },
              },
              { profile: { sub: String(person.subject), email_verified: true } },
              { profile: { sub: {}, email: person.email, email_verified: true } },
              {
                profile: {
                  sub: String(person.subject),
                  email: "not-an-email",
                  email_verified: true,
                },
              },
            ]
          : [
              { emails: [{ email: person.email, primary: true, verified: false }] },
              { emails: [] },
              { profile: { id: "untrusted-id" } },
              { emails: [{ email: person.email, primary: false, verified: true }] },
            ];
      for (const invalid of bad) {
        failed(await callback(api, await start(api, provider), { ...person, ...invalid }));
      }
      const account = await api.register();
      failed(
        await callback(api, await start(api, provider, account.cookie, true), {
          ...person,
          ...bad[0],
        }),
      );
      const newcomer = identity();
      failed(await callback(api, await start(api, provider), { ...newcomer, ...bad[0] }));
      expect(
        await api.database.db.$count(authSchema.user, eq(authSchema.user.email, newcomer.email)),
      ).toBe(0);
      expect(
        await api.database.db.$count(authSchema.session, eq(authSchema.session.userId, user.id)),
      ).toBe(1);
    },
  );

  it("requires fresh verified sessions at link initiation and the same live session after consent", async () => {
    const api = await setup();
    expect((await post(api, "/link-social", { provider: "google" })).statusCode).toBe(403);
    const account = await api.register();
    const person = identity(account.email);
    const pending = await start(api, "google", account.cookie, true);
    await post(api, "/sign-out", {}, account.cookie);
    failed(await callback(api, pending, person), "AUTH_REAUTHENTICATION_REQUIRED");
    const other = await api.register();
    const switched = await start(api, "github", other.cookie, true);
    const fresh = await api.register();
    failed(
      await callback(
        api,
        { ...switched, cookie: switched.cookie.split(";")[0]! + `; ${fresh.cookie}` },
        identity(other.email),
      ),
      "AUTH_OAUTH_CONFLICT",
    );
    const aging = await start(api, "google", fresh.cookie, true);
    await api.database.db
      .update(authSchema.session)
      .set({ createdAt: new Date(Date.now() - 3_601_000) })
      .where(eq(authSchema.session.userId, fresh.userId));
    failed(await callback(api, aging, identity(fresh.email)), "AUTH_REAUTHENTICATION_REQUIRED");
    const stale = await post(api, "/link-social", { provider: "google" }, fresh.cookie);
    expect(stale.statusCode).toBe(403);
    expect(stale.json<{ code: string }>().code).toBe("AUTH_REAUTHENTICATION_REQUIRED");
    await api.database.db
      .update(authSchema.user)
      .set({ emailVerified: false })
      .where(eq(authSchema.user.id, other.userId));
    expect((await post(api, "/link-social", { provider: "github" }, other.cookie)).statusCode).toBe(
      403,
    );
  });

  it("sanitizes cancellation and upstream failures, rejects callback injection, and logs no secrets", async () => {
    const api = await setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const provider of ["google", "github"] as const) {
      const flow = await start(api, provider);
      const denied = await api.app.inject({
        method: "GET",
        url: `/api/auth/callback/${provider}?${new URLSearchParams({ state: flow.state, error: "access_denied", error_description: "callback-secret-canary https://attacker.example/", error_uri: "https://attacker.example/" })}`,
        headers: { cookie: flow.cookie },
      });
      failed(denied);
      for (const failure of ["token", "profile", "redirect", "network", "oversized"] as const) {
        failed(await callback(api, await start(api, provider), { ...identity(), failure }));
      }
      const invalid = await start(api, provider);
      const injected = await api.app.inject({
        method: "GET",
        url: `/api/auth/callback/${provider}?state=${invalid.state}&state=duplicate&code=callback-secret-canary&callbackURL=https://attacker.example/`,
        headers: { cookie: invalid.cookie },
      });
      failed(injected);
    }
    const logs =
      api.logs.join("") +
      JSON.stringify(consoleError.mock.calls) +
      JSON.stringify(consoleWarn.mock.calls);
    for (const secret of [
      "code-canary",
      "state-canary",
      "callback-secret-canary",
      "client-secret-canary",
      "access-token-canary",
      "profile-secret-canary",
      "token-secret-canary",
    ]) {
      expect(logs.includes(secret)).toBe(false);
    }
  });

  it("keeps ordinary exact-origin protections, blocks unreviewed OAuth endpoints, and preserves guest games", async () => {
    const api = await setup();
    for (const path of ["/sign-in/social", "/link-social"]) {
      for (const origin of [undefined, "https://attacker.example"]) {
        const response = await api.app.inject({
          method: "POST",
          url: `/api/auth${path}`,
          payload: { provider: "google" },
          headers: origin ? { origin } : {},
        });
        expect(response.statusCode).toBe(403);
      }
      for (const extra of [
        { callbackURL: "https://attacker.example" },
        { idToken: { token: "forged" } },
        { scopes: ["repo"] },
        { additionalData: { provider: "github" } },
      ]) {
        expect((await post(api, path, { provider: "google", ...extra })).statusCode).toBe(400);
      }
    }
    for (const path of ["/unlink-account", "/get-access-token", "/refresh-token", "/delete-user"]) {
      expect((await post(api, path, {})).statusCode).toBe(404);
    }
    const guest = await harness.guest(api);
    const game = await createSandbox(api, guest);
    await callback(api, await start(api, "google", guest.cookie), identity());
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: `/games/${game.gameId}`,
          headers: { cookie: guest.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/guest-session",
          payload: {},
          headers: { origin: "https://accounts.google.com" },
        })
      ).statusCode,
    ).toBe(403);
  });
});
