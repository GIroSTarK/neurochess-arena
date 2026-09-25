import { randomUUID } from "node:crypto";

import { gameDetailsSchema, profileResponseSchema, reservedUsernames } from "@neurochess/contracts";
import { authSchema, createProfileRepository, games, profiles } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_COOKIE_NAME } from "../src/auth/service.js";
import { createLoggerOptions } from "../src/logger.js";
import { createProfileService } from "../src/profiles/service.js";

import { AccountGameHarness, get, post } from "./account-game-helpers.js";
import { aiMatch, humanMatch, service } from "./ai-turn-helpers.js";
import { command, createSandbox, WEB_ORIGIN } from "./helpers.js";

const harness = new AccountGameHarness();
const username = () => "Player_" + randomUUID().replaceAll("-", "").slice(0, 17);
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

describe("private profiles through Fastify and PostgreSQL", () => {
  it("requires chosen onboarding for new account games while retaining guest and Sandbox access", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api, false);
    const before = await get(api, owner.cookie, "/api/profile");
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      username: null,
      onboardingRequired: true,
      avatar: { source: "initials", initials: null },
      providerAvatar: null,
    });
    expect(before.headers["cache-control"]).toBe("no-store");
    expect(before.body).not.toContain(owner.email);
    expect(before.body).not.toContain("Private fixture name");
    const avatarOnly = await post(api, owner.cookie, "/api/profile", { avatar: "initials" });
    expect(avatarOnly.json()).toMatchObject({ username: null, onboardingRequired: true });
    expect((await post(api, owner.cookie, "/games", aiMatch)).json()).toMatchObject({
      code: "PROFILE_REQUIRED",
    });
    await expect(service(api).createAi(owner.principal, humanMatch)).rejects.toMatchObject({
      code: "PROFILE_REQUIRED",
    });
    const guest = await harness.guest(api);
    await createSandbox(api, guest);
    expect((await post(api, guest.cookie, "/games", aiMatch)).statusCode).toBe(201);
    const name = username();
    const complete = await post(api, owner.cookie, "/api/profile/onboarding", {
      username: `  ${name}  `,
    });
    expect(complete.statusCode).toBe(200);
    expect(profileResponseSchema.parse(complete.json())).toMatchObject({
      username: name,
      onboardingRequired: false,
      avatar: { source: "initials", initials: "PL" },
    });
    const created = await post(api, owner.cookie, "/games", {
      ...humanMatch,
      seats: { white: { type: "human" }, black: aiMatch.seats.white },
    });
    expect(created.statusCode).toBe(201);
    const game = gameDetailsSchema.parse(created.json());
    const renamed = await post(api, owner.cookie, "/api/profile", {
      username: username(),
      avatar: "initials",
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      (
        await post(
          api,
          owner.cookie,
          `/games/${game.snapshot.gameId}/moves`,
          command(game.snapshot, "e2e4"),
        )
      ).statusCode,
    ).toBe(200);
    const stranger = await harness.account(api);
    expect(
      (await get(api, stranger.cookie, `/games/${game.snapshot.gameId}/details`)).statusCode,
    ).toBe(404);
    expect(
      (await post(api, stranger.cookie, "/api/profile/onboarding", { username: name })).statusCode,
    ).toBe(200);
    expect(
      (await get(api, owner.cookie, `/games/${game.snapshot.gameId}/details`)).statusCode,
    ).toBe(200);
  });

  it("preserves recovery and lifecycle authority for account games predating profiles", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const game = await service(api).createAi(owner.principal, aiMatch);
    await api.database.db.delete(profiles).where(eq(profiles.userId, owner.userId));
    expect((await get(api, owner.cookie, "/api/profile")).json()).toMatchObject({
      onboardingRequired: true,
    });
    expect((await get(api, owner.cookie, "/games/unfinished")).statusCode).toBe(200);
    const recovered = await post(api, owner.cookie, `/games/${game.snapshot.gameId}/lifecycle`, {
      gameId: game.snapshot.gameId,
      expectedVersion: game.snapshot.version,
      commandId: randomUUID(),
      action: "pause",
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ state: "paused" });
    expect((await post(api, owner.cookie, "/games", aiMatch)).json()).toMatchObject({
      code: "GAME_CONFLICT",
    });
  });

  it("resolves concurrent case variants across API instances atomically and releases a renamed claim", async () => {
    const first = await harness.createApi();
    const second = await harness.createApi();
    const owners = await Promise.all([
      harness.account(first, false),
      harness.account(second, false),
    ]);
    const name = username();
    const results = await Promise.all([
      post(first, owners[0].cookie, "/api/profile/onboarding", { username: name }),
      post(second, owners[1].cookie, "/api/profile/onboarding", { username: name.toLowerCase() }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const winner = results[0].statusCode === 200 ? owners[0] : owners[1];
    const loser = results[0].statusCode === 200 ? owners[1] : owners[0];
    expect(results.find((result) => result.statusCode === 409)!.json()).toMatchObject({
      code: "USERNAME_UNAVAILABLE",
    });
    expect(
      await first.database.db.$count(profiles, eq(profiles.usernameNormalized, name.toLowerCase())),
    ).toBe(1);
    const secondName = username();
    expect(
      (await post(first, loser.cookie, "/api/profile", { username: secondName })).statusCode,
    ).toBe(200);
    expect(
      (await post(first, loser.cookie, "/api/profile", { username: name, avatar: "initials" }))
        .statusCode,
    ).toBe(409);
    const unchanged = await first.database.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, loser.userId));
    expect(unchanged).toMatchObject([{ username: secondName, avatarPreference: "provider" }]);
    expect(
      (await post(second, winner.cookie, "/api/profile", { username: name.toUpperCase() }))
        .statusCode,
    ).toBe(200);
    expect(
      (await post(second, winner.cookie, "/api/profile", { username: username() })).statusCode,
    ).toBe(200);
    expect((await post(first, loser.cookie, "/api/profile", { username: name })).statusCode).toBe(
      200,
    );
  });

  it("preserves independent fields when two sessions of one account update concurrently", async () => {
    const first = await harness.createApi();
    const second = await harness.createApi();
    const owner = await harness.account(first);
    const other = await harness.anotherSession(second, owner);
    const name = username();
    const results = await Promise.all([
      post(first, owner.cookie, "/api/profile", { username: name }),
      post(second, other.cookie, "/api/profile", { avatar: "initials" }),
    ]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(
      await first.database.db.select().from(profiles).where(eq(profiles.userId, owner.userId)),
    ).toMatchObject([{ username: name, avatarPreference: "initials" }]);
    await harness.close(first);
    expect((await get(second, other.cookie, "/api/profile")).json()).toMatchObject({
      username: name,
      onboardingRequired: false,
    });
  });

  it("rejects guest, forged, expired, revoked and cross-account requests without leaking private data", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const guest = await harness.guest(api);
    const stranger = await harness.account(api);
    for (const cookie of ["", guest.cookie, `${AUTH_COOKIE_NAME}=forged; ${guest.cookie}`]) {
      expect((await get(api, cookie, "/api/profile")).statusCode).toBe(401);
      expect((await post(api, cookie, "/api/profile", { username: username() })).statusCode).toBe(
        401,
      );
    }
    for (const extra of [
      { userId: owner.userId },
      { id: owner.userId },
      { email: owner.email },
      { image: "https://avatars.githubusercontent.com/u/123" },
      { avatarUrl: "https://evil.test" },
      { usernameNormalized: "forged" },
    ]) {
      expect(
        (await post(api, stranger.cookie, "/api/profile", { username: username(), ...extra }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (await get(api, stranger.cookie, `/api/profile?userId=${owner.userId}`)).statusCode,
    ).toBe(400);
    expect((await get(api, stranger.cookie, `/api/profile/${owner.userId}`)).statusCode).toBe(404);
    expect((await get(api, stranger.cookie, "/api/profiles")).statusCode).toBe(404);
    expect(
      (await post(api, owner.cookie, "/api/profile", { avatar: "provider" })).json(),
    ).toMatchObject({ code: "AVATAR_UNAVAILABLE" });
    await api.database.db
      .update(authSchema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSchema.session.id, owner.principal.sessionId));
    expect(
      (await post(api, owner.cookie, "/api/profile", { username: username() })).statusCode,
    ).toBe(401);
    await post(api, stranger.cookie, "/api/auth/sign-out", {});
    expect((await get(api, stranger.cookie, "/api/profile")).statusCode).toBe(401);
  });

  it("requires exact-origin JSON, strict bodies and queries, and keeps malicious input out of errors/logs", async () => {
    const logs: string[] = [];
    const api = await harness.createApi({
      logger: {
        ...createLoggerOptions("info"),
        stream: { write: (chunk: string) => logs.push(chunk) },
      },
    });
    const owner = await harness.account(api);
    const canary = "<img src=x onerror=private-canary>";
    for (const payload of [
      {},
      { username: canary },
      { username: "Admin" },
      { username: null },
      { avatar: canary },
      { avatar: { source: "google", url: canary } },
    ]) {
      const result = await post(api, owner.cookie, "/api/profile", payload);
      expect(result.statusCode).toBe(400);
      expect(result.body).not.toContain(canary);
    }
    expect(
      (await post(api, owner.cookie, "/api/profile/onboarding", { avatar: "initials" })).statusCode,
    ).toBe(400);
    expect(
      (await post(api, owner.cookie, "/api/profile?username=x", { username: username() }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          api,
          owner.cookie,
          "/api/profile",
          { username: username() },
          { origin: "https://evil.test" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/api/profile",
          payload: { username: username() },
          headers: { cookie: owner.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/api/profile",
          payload: "{}",
          headers: { cookie: owner.cookie, origin: WEB_ORIGIN, "content-type": "text/plain" },
        })
      ).statusCode,
    ).toBe(400);
    expect(logs.join("")).not.toContain(canary);
    expect(logs.join("")).not.toContain(owner.email);
    expect(logs.join("")).not.toContain(owner.token);
    const failing = vi
      .spyOn(api.database.db, "transaction")
      .mockRejectedValueOnce(new Error(canary));
    const failure = await get(api, owner.cookie, "/api/profile");
    failing.mockRestore();
    expect(failure.statusCode).toBe(500);
    expect(failure.body + logs.join("")).not.toContain(canary);
  });

  it("uses initials for invalid persisted provider images without fetching them", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    await api.database.db.insert(authSchema.account).values({
      id: randomUUID(),
      userId: owner.userId,
      accountId: randomUUID(),
      providerId: "google",
      updatedAt: new Date(),
    });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No image fetch permitted"));
    for (const image of [
      null,
      "https://evil.test/a",
      "javascript:alert(1)",
      "<svg onload=alert(1)>",
      "https://avatars.githubusercontent.com/u/123",
    ]) {
      await api.database.db
        .update(authSchema.user)
        .set({ image })
        .where(eq(authSchema.user.id, owner.userId));
      const result = await get(api, owner.cookie, "/api/profile");
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ avatar: { source: "initials" }, providerAvatar: null });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces validation and normalized uniqueness even on direct SQL writes", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api, false);
    for (const name of [
      "ab",
      "A".repeat(25),
      "_Name",
      "9Name",
      " Name",
      "Name ",
      "Name\n",
      "Àlice",
      ...reservedUsernames,
    ]) {
      await expect(
        api.database.db
          .insert(profiles)
          .values({ userId: owner.userId, username: name, usernameNormalized: name.toLowerCase() }),
      ).rejects.toThrow();
    }
    for (const values of [
      { username: "Alice", usernameNormalized: "ALICE" },
      { username: "Alice", usernameNormalized: null },
      { username: null, usernameNormalized: "alice" },
    ]) {
      await expect(
        api.database.db.insert(profiles).values({ userId: owner.userId, ...values }),
      ).rejects.toThrow();
    }
    await expect(
      api.database.db.insert(profiles).values({ userId: randomUUID() }),
    ).rejects.toThrow();
    const name = username();
    await api.database.db
      .insert(profiles)
      .values({ userId: owner.userId, username: name, usernameNormalized: name.toLowerCase() });
    const second = await harness.account(api, false);
    await expect(
      api.database.db.insert(profiles).values({
        userId: second.userId,
        username: name.toUpperCase(),
        usernameNormalized: name.toLowerCase(),
      }),
    ).rejects.toThrow();
    await api.database.db.delete(authSchema.user).where(eq(authSchema.user.id, owner.userId));
    expect(await api.database.db.$count(profiles, eq(profiles.userId, owner.userId))).toBe(0);
  });

  it("rechecks revoked sessions after identity lock waits", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api, false);
    const profileService = createProfileService(createProfileRepository(api.database));
    let pending: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx
        .select()
        .from(authSchema.user)
        .where(eq(authSchema.user.id, owner.userId))
        .for("update");
      pending = profileService
        .update(owner.principal, { username: username() })
        .catch((error: unknown) => error);
      await tx
        .delete(authSchema.session)
        .where(eq(authSchema.session.id, owner.principal.sessionId));
    });
    expect(await pending).toMatchObject({ code: "PROFILE_UNAUTHORIZED" });
    expect(await api.database.db.$count(profiles, eq(profiles.userId, owner.userId))).toBe(0);
  });

  it("rolls back a claim if the session expires waiting for the username index", async () => {
    const first = await harness.createApi();
    const second = await harness.createApi();
    const blocker = await harness.account(first, false);
    const owner = await harness.account(second, false);
    const name = username();
    let pending: Promise<unknown> | undefined;
    const profileService = createProfileService(createProfileRepository(second.database));
    const rollback = new Error("rollback-blocking-claim");
    await expect(
      first.database.db.transaction(async (tx) => {
        await tx.insert(profiles).values({
          userId: blocker.userId,
          username: name,
          usernameNormalized: name.toLowerCase(),
        });
        await second.database.db
          .update(authSchema.session)
          .set({ expiresAt: sql`(clock_timestamp() at time zone 'UTC') + interval '1 second'` })
          .where(eq(authSchema.session.id, owner.principal.sessionId));
        pending = profileService
          .update(owner.principal, { username: name })
          .catch((error: unknown) => error);
        await vi.waitFor(async () => {
          const result = await second.database.db.execute(
            sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'insert into "profiles"%'`,
          );
          expect(result.rows.length).toBeGreaterThan(0);
        });
        await tx.execute(sql`select pg_sleep(1.1)`);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await pending).toMatchObject({ code: "PROFILE_UNAUTHORIZED" });
    expect(await second.database.db.$count(profiles, eq(profiles.userId, owner.userId))).toBe(0);
    expect(await second.database.db.$count(games, eq(games.ownerUserId, owner.userId))).toBe(0);
  });
});
