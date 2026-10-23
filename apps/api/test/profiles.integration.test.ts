import { randomUUID } from "node:crypto";

import {
  aiControllers,
  authAccounts,
  authSessions,
  authUsers,
  createProfileRepository,
  gameParticipants,
  games,
  profiles,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";
import { createLoggerOptions } from "../src/logger.js";
import { createProfileService } from "../src/profiles/service.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { aiMatch, control, humanMatch, turnCommand } from "./ai-turn-helpers.js";
import { command, createSandbox } from "./helpers.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

describe("private account profiles", () => {
  it("rejects guests, forged and revoked cookies, foreign targets, and unwanted fields", async () => {
    const logs: string[] = [];
    const api = await harness.createAuthenticatedApi({
      logger: {
        ...createLoggerOptions("info"),
        stream: { write: (value: string) => logs.push(value) },
      },
    });
    const account = await harness.account(api);
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    const before: unknown = (
      await api.app.inject({ url: "/profile", headers: { cookie: account.cookie } })
    ).json();
    for (const cookie of ["", guest.cookie, "__Secure-neurochess.session_token=forged-canary"]) {
      expect((await api.app.inject({ url: "/profile", headers: { cookie } })).statusCode).toBe(401);
      expect(
        (await harness.post(api, cookie, "/profile", { username: "Unauthorized" })).statusCode,
      ).toBe(401);
    }
    for (const payload of [
      {},
      { username: "Admin" },
      { username: "<script>canary</script>" },
      { username: "Target", userId: other.principal.userId },
      { avatar: "https://evil.example/avatar-canary" },
      { email: "email-canary@example.com" },
      { name: "untrusted-name-canary" },
      { username: null },
    ]) {
      const response = await harness.post(api, account.cookie, "/profile", payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "PROFILE_INVALID_REQUEST" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.body).not.toMatch(/canary|<script>|evil\.example/);
    }
    for (const origin of [undefined, "https://evil.example"]) {
      expect(
        (
          await api.app.inject({
            method: "POST",
            url: "/profile",
            payload: { avatar: "remove" },
            headers: { cookie: account.cookie, ...(origin ? { origin } : {}) },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await api.app.inject({
          url: `/profile?userId=${other.principal.userId}`,
          headers: { cookie: account.cookie },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api.app.inject({
          url: `/profile/${other.principal.userId}`,
          headers: { cookie: account.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api.app.inject({ url: "/profiles", headers: { cookie: account.cookie } })).statusCode,
    ).toBe(404);
    expect(
      (await api.app.inject({ url: "/profile", headers: { cookie: account.cookie } })).json(),
    ).toEqual(before);
    await harness.post(api, account.cookie, "/api/auth/sign-out", {});
    expect(
      (
        await harness.post(api, `${account.cookie}; ${guest.cookie}`, "/profile", {
          avatar: "remove",
        })
      ).statusCode,
    ).toBe(401);
    expect(logs.join("")).not.toMatch(/canary|evil\.example|<script>/);
  });

  it("requires explicit username onboarding before account gameplay", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api, false);
    const blocked = await harness.post(api, account.cookie, "/games", aiMatch);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "PROFILE_REQUIRED" });
    const guest = await harness.guest(api);
    expect(
      (await harness.post(api, `${account.cookie}; ${guest.cookie}`, "/games", aiMatch)).statusCode,
    ).toBe(403);
    expect(
      (
        await harness.post(api, account.cookie, "/providers/models", {
          provider: "openai",
          apiKey: "fixture-key",
        })
      ).json(),
    ).toMatchObject({ code: "PROFILE_REQUIRED" });
    const service = createGameService(api.repository, { nodeEnv: "test", sandboxEnabled: true });
    await expect(service.createAi(account.principal, aiMatch)).rejects.toMatchObject({
      code: "PROFILE_REQUIRED",
    });
    expect(
      (await createSandbox(api, { ...guest, cookie: `${account.cookie}; ${guest.cookie}` })).state,
    ).toBe("active");
    const initial = await api.app.inject({ url: "/profile", headers: { cookie: account.cookie } });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      username: null,
      completed: false,
      avatar: { source: "initials", initials: "?" },
    });
    const username = `Player_${randomUUID().slice(0, 8)}`;
    const completed = await harness.post(api, account.cookie, "/profile/onboarding", {
      username: `  ${username}  `,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({
      username,
      completed: true,
      avatar: { source: "initials", initials: "PL" },
    });
    expect((await harness.post(api, account.cookie, "/games", aiMatch)).statusCode).toBe(201);
  });

  it("serializes concurrent case-insensitive claims and preserves a failed rename", async () => {
    const api = await harness.createAuthenticatedApi();
    const a = await harness.account(api, false);
    const b = await harness.account(api, false);
    const username = `Race_${randomUUID().slice(0, 8)}`;
    const claims = await Promise.all([
      harness.post(api, a.cookie, "/profile/onboarding", { username }),
      harness.post(api, b.cookie, "/profile/onboarding", { username: username.toUpperCase() }),
    ]);
    expect(claims.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = claims[0].statusCode === 200 ? a : b;
    const loser = winner === a ? b : a;
    expect(claims.find((r) => r.statusCode === 409)!.json()).toMatchObject({
      code: "PROFILE_USERNAME_TAKEN",
    });
    const otherName = `Other_${randomUUID().slice(0, 8)}`;
    expect(
      (await harness.post(api, loser.cookie, "/profile/onboarding", { username: otherName }))
        .statusCode,
    ).toBe(200);
    await api.database.db
      .update(authUsers)
      .set({ image: "https://avatars.githubusercontent.com/u/rollback" })
      .where(eq(authUsers.id, loser.principal.userId));
    expect(
      (await harness.post(api, loser.cookie, "/profile", { username, avatar: "remove" }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await api.database.db
          .select({ image: authUsers.image })
          .from(authUsers)
          .where(eq(authUsers.id, loser.principal.userId))
      )[0],
    ).toEqual({ image: "https://avatars.githubusercontent.com/u/rollback" });
    expect(
      (
        await api.database.db
          .select({ removed: profiles.avatarRemoved })
          .from(profiles)
          .where(eq(profiles.userId, loser.principal.userId))
      )[0],
    ).toEqual({ removed: false });
    expect(
      (await api.app.inject({ url: "/profile", headers: { cookie: loser.cookie } })).json(),
    ).toMatchObject({ username: otherName });
    expect(
      (
        await harness.post(api, winner.cookie, "/profile", {
          username: `New_${randomUUID().slice(0, 8)}`,
        })
      ).statusCode,
    ).toBe(200);
    expect((await harness.post(api, loser.cookie, "/profile", { username })).statusCode).toBe(200);
    expect(
      (
        await harness.post(api, loser.cookie, "/profile", { username: username.toUpperCase() })
      ).json(),
    ).toMatchObject({ username: username.toUpperCase() });
  });

  it("preserves owner, human seat and unfinished-slot authority across renames and sessions", async () => {
    const api = await harness.createAuthenticatedApi();
    const a = await harness.account(api);
    const b = await harness.account(api);
    const second = await a.anotherSession();
    const details = await harness.createGame(api, a.cookie, humanMatch);
    const [before] = await api.database.db
      .select()
      .from(games)
      .where(eq(games.id, details.snapshot.gameId));
    const seats = await api.database.db
      .select()
      .from(gameParticipants)
      .where(eq(gameParticipants.gameId, details.snapshot.gameId));
    const username = `Renamed_${randomUUID().slice(0, 8)}`;
    expect(
      (await harness.post(api, a.cookie, "/profile", { username, avatar: "remove" })).statusCode,
    ).toBe(200);
    const otherApi = await harness.createAuthenticatedApi();
    expect(
      (await otherApi.app.inject({ url: "/profile", headers: { cookie: second.cookie } })).json(),
    ).toMatchObject({ username, completed: true });
    expect(
      (
        await otherApi.app.inject({
          url: `/games/${details.snapshot.gameId}/details`,
          headers: { cookie: second.cookie },
        })
      ).json(),
    ).toEqual(details);
    expect(
      (
        await otherApi.app.inject({
          url: `/games/${details.snapshot.gameId}`,
          headers: { cookie: b.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect((await harness.post(api, second.cookie, "/games", aiMatch)).statusCode).toBe(409);
    expect(
      await api.database.db.select().from(games).where(eq(games.id, details.snapshot.gameId)),
    ).toEqual([before]);
    expect(
      await api.database.db
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, details.snapshot.gameId)),
    ).toEqual(seats);
  });

  it("gates existing account game routes while keeping abandoned-game cleanup available", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const { snapshot } = await harness.createGame(api, account.cookie, humanMatch);
    await api.database.db.delete(profiles).where(eq(profiles.userId, account.principal.userId));
    for (const url of [
      "/games/unfinished",
      ...["", "/details", "/invocations", "/replay", "/pgn"].map(
        (suffix) => `/games/${snapshot.gameId}${suffix}`,
      ),
    ]) {
      const response = await api.app.inject({ url, headers: { cookie: account.cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "PROFILE_REQUIRED" });
    }
    for (const [suffix, payload] of [
      ["/moves", command(snapshot, "e2e4")],
      ["/lifecycle", control(snapshot, "pause", snapshot.gameId)],
      [
        "/controller",
        {
          gameId: snapshot.gameId,
          controllerId: snapshot.gameId,
          expectedVersion: 0,
          action: "acquire",
        },
      ],
      ["/ai-turn", { ...turnCommand(snapshot, snapshot.gameId), apiKey: "fixture-key" }],
    ] as const) {
      const response = await harness.post(
        api,
        account.cookie,
        `/games/${snapshot.gameId}${suffix}`,
        payload,
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "PROFILE_REQUIRED" });
    }
    await api.database.db
      .update(aiControllers)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(aiControllers.gameId, snapshot.gameId));
    const service = createGameService(api.repository, { nodeEnv: "test", sandboxEnabled: true });
    await service.expireControllers();
    expect(
      (
        await api.database.db
          .select({ state: games.state })
          .from(games)
          .where(eq(games.id, snapshot.gameId))
      )[0],
    ).toEqual({ state: "paused" });
    expect(
      (
        await harness.post(api, account.cookie, "/profile/onboarding", {
          username: `Return_${randomUUID().slice(0, 8)}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(await service.snapshot(account.principal, snapshot.gameId)).toMatchObject({
      gameId: snapshot.gameId,
      state: "paused",
    });
  });

  it("projects only bound safe provider avatars, never auth names or arbitrary stored images", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api, false);
    const read = () => api.app.inject({ url: "/profile", headers: { cookie: account.cookie } });
    const setImage = (image: string | null) =>
      api.database.db
        .update(authUsers)
        .set({ image, name: "<svg>untrusted-name</svg>" })
        .where(eq(authUsers.id, account.principal.userId));
    await setImage("https://avatars.githubusercontent.com/u/123");
    expect((await read()).json()).toMatchObject({
      username: null,
      avatar: { source: "initials", initials: "?" },
    });
    await api.database.db
      .insert(authAccounts)
      .values({ userId: account.principal.userId, providerId: "github", accountId: randomUUID() });
    expect((await read()).json()).toMatchObject({
      avatar: {
        source: "github",
        url: "https://avatars.githubusercontent.com/u/123",
        initials: "?",
      },
    });
    for (const image of [
      null,
      "javascript:alert(1)",
      "<img src=x onerror=alert(1)>",
      "http://127.0.0.1/private",
      "https://lh3.googleusercontent.com/a",
      "https://evil.example/private-canary",
    ]) {
      await setImage(image);
      const response = await read();
      expect(response.json()).toEqual({
        username: null,
        completed: false,
        avatar: { source: "initials", initials: "?" },
      });
      expect(response.body).not.toMatch(/untrusted-name|image|email|canary/);
    }
    await setImage("https://avatars.githubusercontent.com/u/123");
    expect(
      (await harness.post(api, account.cookie, "/profile", { avatar: "remove" })).json(),
    ).toMatchObject({ completed: false, avatar: { source: "initials" } });
    // Even an old provider write cannot undo a persisted removal preference.
    await setImage("https://avatars.githubusercontent.com/u/456");
    expect((await read()).json()).toMatchObject({ avatar: { source: "initials" } });
  });

  it("rejects expired and mismatched sessions in the profile repository", async () => {
    const api = await harness.createAuthenticatedApi();
    const a = await harness.account(api);
    const b = await harness.account(api);
    const service = createProfileService(createProfileRepository(api.database));
    await expect(
      service.update({ ...a.principal, sessionId: b.principal.sessionId }, { avatar: "remove" }),
    ).rejects.toMatchObject({ code: "PROFILE_UNAUTHORIZED" });
    await api.database.db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(authSessions.id, a.principal.sessionId));
    await expect(service.read(a.principal)).rejects.toMatchObject({ code: "PROFILE_UNAUTHORIZED" });
    await expect(service.update(a.principal, { avatar: "remove" })).rejects.toMatchObject({
      code: "PROFILE_UNAUTHORIZED",
    });
    expect(
      (await api.app.inject({ url: "/profile", headers: { cookie: a.cookie } })).statusCode,
    ).toBe(401);
  });

  it("rechecks revocation after waiting for the account row lock", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api, false);
    const repository = createProfileRepository(api.database);
    let pending: ReturnType<typeof repository.update> | undefined;
    await api.database.db.transaction(async (tx) => {
      const blocker = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, account.principal.userId))
        .for("update");
      pending = repository.update(account.principal, { username: "RevokedUpdate" });
      await expect
        .poll(async () => {
          // A new waiting backend must not be hidden by this transaction's cached activity snapshot.
          await tx.execute(sql`select pg_stat_clear_snapshot()`);
          const waiting = await tx.execute<{ count: number }>(
            sql`select count(*)::int as count from pg_stat_activity where ${blocker.rows[0]!.pid} = any(pg_blocking_pids(pid))`,
          );
          return waiting.rows[0]!.count;
        })
        .toBeGreaterThan(0);
      await tx.delete(authSessions).where(eq(authSessions.id, account.principal.sessionId));
    });
    expect(await pending).toBeUndefined();
    expect(
      await api.database.db.$count(profiles, eq(profiles.userId, account.principal.userId)),
    ).toBe(0);
  });

  it("rolls back username and avatar changes if the session expires during a username claim wait", async () => {
    const api = await harness.createAuthenticatedApi();
    const claimant = await harness.account(api, false);
    const blocker = await harness.account(api, false);
    const oldName = `Before_${randomUUID().slice(0, 8)}`;
    const targetName = `Target_${randomUUID().slice(0, 8)}`;
    expect(
      (await harness.post(api, claimant.cookie, "/profile/onboarding", { username: oldName }))
        .statusCode,
    ).toBe(200);
    const image = "https://avatars.githubusercontent.com/u/expiry";
    await api.database.db
      .update(authUsers)
      .set({ image })
      .where(eq(authUsers.id, claimant.principal.userId));
    const repository = createProfileRepository(api.database);
    let pending: ReturnType<typeof repository.update> | undefined;
    await api.database.db.transaction(async (tx) => {
      const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.insert(profiles).values({
        userId: blocker.principal.userId,
        username: targetName,
        usernameNormalized: targetName.toLowerCase(),
      });
      pending = repository.update(claimant.principal, { username: targetName, removeAvatar: true });
      await expect
        .poll(async () => {
          // The waiting connection may be created after this transaction's first stats read.
          await tx.execute(sql`select pg_stat_clear_snapshot()`);
          const waiting = await tx.execute<{ count: number }>(
            sql`select count(*)::int as count from pg_stat_activity where ${result.rows[0]!.pid} = any(pg_blocking_pids(pid))`,
          );
          return waiting.rows[0]!.count;
        })
        .toBeGreaterThan(0);
      await tx
        .update(authSessions)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(authSessions.id, claimant.principal.sessionId));
      await tx.delete(profiles).where(eq(profiles.userId, blocker.principal.userId));
    });
    expect(await pending).toBeUndefined();
    expect(
      (
        await api.database.db
          .select({ username: profiles.username, avatarRemoved: profiles.avatarRemoved })
          .from(profiles)
          .where(eq(profiles.userId, claimant.principal.userId))
      )[0],
    ).toEqual({ username: oldName, avatarRemoved: false });
    expect(
      (
        await api.database.db
          .select({ image: authUsers.image })
          .from(authUsers)
          .where(eq(authUsers.id, claimant.principal.userId))
      )[0],
    ).toEqual({ image });
  });
});
