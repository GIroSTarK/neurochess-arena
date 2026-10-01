import { createHash, randomUUID } from "node:crypto";

import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  games,
} from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";
import { AccountGameHarness } from "../../apps/api/test/account-game-helpers.js";
import { integrationDatabase } from "../database.js";

import { accountHarness } from "./account-harness.js";
import { WEB_ORIGIN } from "./environment.js";

const external = new AccountGameHarness();
const extraIds: string[] = [];
const externalVerificationIds: string[] = [];
let database: ReturnType<typeof integrationDatabase>;
let fixture: ReturnType<typeof accountHarness>;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  database = integrationDatabase();
  fixture = accountHarness(database);
  app = await buildApp({ readiness: database, webOrigin: WEB_ORIGIN, auth: fixture.auth });
  fixture.install(app);
});
afterEach(async () => {
  await app.close();
  await fixture.close();
  if (externalVerificationIds.length) {
    await database.db
      .delete(authVerifications)
      .where(inArray(authVerifications.id, externalVerificationIds.splice(0)));
  }
  if (extraIds.length) {
    await database.db.delete(games).where(inArray(games.ownerUserId, extraIds));
    await database.db.delete(authUsers).where(inArray(authUsers.id, extraIds.splice(0)));
  }
  await external.dispose();
  await database.close();
});
const post = (path: string, payload: object) =>
  app.inject({ method: "POST", url: path, headers: { origin: WEB_ORIGIN }, payload });
async function existingAccount() {
  const api = await external.createAuthenticatedApi();
  const account = await external.account(api);
  const game = await external.createGame(api, account.cookie);
  const [user] = await database.db
    .select()
    .from(authUsers)
    .where(eq(authUsers.id, account.principal.userId));
  if (!user) throw new Error("Missing external fixture user");
  return { user, game };
}
async function userId(email: string) {
  const [user] = await database.db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, email));
  if (!user) throw new Error("Missing created fixture user");
  return user.id;
}
async function oauth(provider: "google" | "github", email: string, cancel: boolean) {
  const start = await post("/api/auth/sign-in/social", { provider });
  expect(start.statusCode).toBe(200);
  const grant = await post("/__test__/oauth", {
    provider,
    email,
    cancel,
    url: start.json<{ url: string }>().url,
  });
  const callback = new URL(grant.json<{ url: string }>().url);
  const cookie = start.cookies.map((value) => `${value.name}=${value.value}`).join("; ");
  const completed = await app.inject({
    url: callback.pathname + callback.search,
    headers: { cookie },
  });
  expect(completed.statusCode).toBe(303);
  expect(completed.headers.location).toBe(
    WEB_ORIGIN + (cancel ? "/?auth=oauth-error&code=AUTH_OAUTH_CANCELLED" : "/?auth=signed-in"),
  );
}

it("preserves another fixture's account and game after reset, duplicate registration and canceled OAuth", async () => {
  const { user, game } = await existingAccount();
  const priorVerification = randomUUID();
  externalVerificationIds.push(priorVerification);
  await database.db.insert(authVerifications).values({
    id: priorVerification,
    identifier: `reset-password:${randomUUID()}`,
    value: user.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect((await post("/api/auth/request-password-reset", { email: user.email })).statusCode).toBe(
    200,
  );
  expect(
    (
      await post("/api/auth/sign-up/email", {
        email: user.email,
        password: "duplicate-fixture-password",
      })
    ).statusCode,
  ).toBe(200);
  await oauth("google", user.email, true);
  await app.close();
  expect(await database.db.$count(authVerifications, eq(authVerifications.value, user.id))).toBe(2);
  await fixture.close();
  expect(await database.db.$count(authUsers, eq(authUsers.id, user.id))).toBe(1);
  expect(await database.db.$count(games, eq(games.id, game.snapshot.gameId))).toBe(1);
  expect(await database.db.$count(authVerifications, eq(authVerifications.value, user.id))).toBe(1);
  expect(
    await database.db.$count(authVerifications, eq(authVerifications.id, priorVerification)),
  ).toBe(1);
});

it("cleans an actually registered user by immutable ID even if its email changes", async () => {
  const { game } = await existingAccount();
  const email = `${randomUUID()}@example.com`;
  expect(
    (await post("/api/auth/sign-up/email", { email, password: "created-fixture-password" }))
      .statusCode,
  ).toBe(200);
  const id = await userId(email);
  extraIds.push(id);
  const [record] = await database.db.select().from(games).where(eq(games.id, game.snapshot.gameId));
  if (!record) throw new Error("Missing fixture game");
  await database.db.insert(games).values({ ...record, id: randomUUID(), ownerUserId: id });
  await database.db
    .update(authUsers)
    .set({ email: `${randomUUID()}@example.com` })
    .where(eq(authUsers.id, id));
  await app.close();
  await fixture.close();
  expect(await database.db.$count(authUsers, eq(authUsers.id, id))).toBe(0);
  expect(await database.db.$count(games, eq(games.ownerUserId, id))).toBe(0);
});

it.each(["google", "github"] as const)(
  "owns new %s accounts but does not acquire ownership through a returning sign-in",
  async (provider) => {
    const { user, game } = await existingAccount();
    const previousSessions = await database.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, user.id));
    const subject =
      provider === "google"
        ? user.email
        : String(parseInt(createHash("sha256").update(user.email).digest("hex").slice(0, 10), 16));
    await database.db
      .insert(authAccounts)
      .values({ id: randomUUID(), userId: user.id, providerId: provider, accountId: subject });
    await oauth(provider, user.email, false);
    const email = `${randomUUID()}@example.com`;
    await oauth(provider, email, false);
    const created = await userId(email);
    extraIds.push(created);
    await database.db
      .update(authUsers)
      .set({ email: `${randomUUID()}@example.com` })
      .where(eq(authUsers.id, created));
    await app.close();
    await fixture.close();
    expect(await database.db.$count(authUsers, eq(authUsers.id, user.id))).toBe(1);
    expect(await database.db.$count(games, eq(games.id, game.snapshot.gameId))).toBe(1);
    expect(
      await database.db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.userId, user.id)),
    ).toEqual(previousSessions);
    expect(await database.db.$count(authUsers, eq(authUsers.id, created))).toBe(0);
  },
);
