import { randomUUID } from "node:crypto";

import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  profiles,
  providerCredentials,
} from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { AccountGameHarness } from "./account-game-helpers.js";
import {
  access,
  aiMatch,
  control,
  gatedAdapter,
  output,
  service,
  turnCommand,
} from "./ai-turn-helpers.js";
import { createSandbox, type TestApi, WEB_ORIGIN } from "./helpers.js";
import { gameRecords, residualExecution, terminalGame } from "./history-deletion-helpers.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());
const path = "/api/auth/delete-account";

async function accountRecords(api: TestApi, userId: string) {
  return {
    users: await api.database.db.select().from(authUsers).where(eq(authUsers.id, userId)),
    sessions: await api.database.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, userId)),
    logins: await api.database.db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, userId)),
    profiles: await api.database.db.select().from(profiles).where(eq(profiles.userId, userId)),
    credentials: await api.database.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId)),
    tokens: await api.database.db
      .select()
      .from(authVerifications)
      .where(eq(authVerifications.value, userId)),
  };
}

describe("account deletion", () => {
  it("rate limits stale identity attempts even though deletion rolls back", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    await api.database.db
      .update(authSessions)
      .set({ createdAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(authSessions.id, owner.principal.sessionId));
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await harness.post(api, owner.cookie, path, { confirm: true })).statusCode).toBe(403);
    }
    expect((await harness.post(api, owner.cookie, path, { confirm: true })).statusCode).toBe(429);
    expect((await accountRecords(api, owner.principal.userId)).users).toHaveLength(1);
  });
  it("atomically removes all account data and every game state while preserving other identities", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    const otherGame = await harness.createGame(api, other.cookie);
    const guestGame = await harness.createGame(api, guest.cookie);
    const sandbox = await createSandbox(api, guest);
    const stopped = await terminalGame(harness, api, owner);
    const completed = await terminalGame(harness, api, owner, true);
    await residualExecution(api, stopped);
    const { snapshot: active } = await harness.createGame(api, owner.cookie);
    const second = await owner.anotherSession();
    const credentialId = randomUUID();
    expect(
      (
        await harness.post(api, owner.cookie, "/credentials", {
          credentialId,
          provider: "openai",
          label: "Deleted",
          apiKey: "fixture-deletion-secret",
          save: true,
        })
      ).statusCode,
    ).toBe(201);
    await api.database.db.insert(authVerifications).values({
      identifier: `reset-password:${randomUUID()}`,
      value: owner.principal.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const before = await accountRecords(api, owner.principal.userId);
    expect(Object.values(before).every((rows) => rows.length > 0)).toBe(true);
    const gameBefore = await gameRecords(api, stopped.gameId);
    expect(Object.values(gameBefore).every((rows) => rows.length > 0)).toBe(true);
    const preserved = await accountRecords(api, other.principal.userId);
    const response = await harness.post(api, `${owner.cookie}; ${guest.cookie}`, path, {
      confirm: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      response.cookies.some(
        (cookie) => cookie.name.includes("session_token") && cookie.value === "",
      ),
    ).toBe(true);
    expect(response.cookies.some((cookie) => cookie.name.includes("guest"))).toBe(false);
    expect(
      Object.values(await accountRecords(api, owner.principal.userId)).every(
        (rows) => rows.length === 0,
      ),
    ).toBe(true);
    for (const game of [stopped, completed, active]) {
      expect(
        Object.values(
          await gameRecords(
            api,
            game.gameId,
            game === stopped ? gameBefore.turns.map((turn) => turn.id) : undefined,
          ),
        ).every((rows) => rows.length === 0),
      ).toBe(true);
      for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
        expect(
          (
            await api.app.inject({
              url: `/games/${game.gameId}${suffix}`,
              headers: { cookie: second.cookie, "x-neurochess-identity": "account" },
            })
          ).statusCode,
        ).toBe(401);
      }
    }
    for (const cookie of [owner.cookie, second.cookie]) {
      expect(
        (await api.app.inject({ url: "/api/auth/get-session", headers: { cookie } })).json(),
      ).toBeNull();
      expect((await harness.post(api, cookie, path, { confirm: true })).statusCode).toBe(401);
      expect(
        (await harness.post(api, cookie, "/providers/models", { provider: "openai", credentialId }))
          .statusCode,
      ).toBe(401);
    }
    expect(await accountRecords(api, other.principal.userId)).toEqual(preserved);
    for (const id of [otherGame.snapshot.gameId, guestGame.snapshot.gameId, sandbox.gameId]) {
      expect((await gameRecords(api, id)).games).toHaveLength(1);
    }
  });

  it("requires explicit confirmation, a matching account and a newly authenticated session", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api, false);
    const guest = await harness.guest(api);
    for (const payload of [
      {},
      { confirm: false },
      { confirm: "true" },
      { confirm: true, userId: randomUUID() },
    ]) {
      expect((await harness.post(api, owner.cookie, path, payload)).statusCode).toBe(400);
    }
    for (const cookie of ["", guest.cookie, "__Secure-neurochess.session_token=forged"]) {
      expect((await harness.post(api, cookie, path, { confirm: true })).statusCode).toBe(401);
    }
    for (const origin of [undefined, "https://foreign.example"]) {
      expect(
        (
          await api.app.inject({
            method: "POST",
            url: path,
            payload: { confirm: true },
            headers: { cookie: owner.cookie, ...(origin ? { origin } : {}) },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: path,
          payload: { confirm: true },
          headers: {
            cookie: owner.cookie,
            origin: WEB_ORIGIN,
            "x-neurochess-expected-account": randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("rejects a stale session even after refresh and permits fresh sign-in without profile onboarding", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api, false);
    await api.database.db
      .update(authSessions)
      .set({ createdAt: new Date(Date.now() - 6 * 60_000), updatedAt: new Date() })
      .where(eq(authSessions.id, owner.principal.sessionId));
    const stale = await harness.post(api, owner.cookie, path, { confirm: true });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: "AUTH_REAUTH_REQUIRED" });
    expect((await accountRecords(api, owner.principal.userId)).users).toHaveLength(1);
    const fresh = await owner.anotherSession();
    expect((await harness.post(api, fresh.cookie, path, { confirm: true })).statusCode).toBe(200);
    for (const alternate of ["/delete-user", "/delete-user/callback"]) {
      expect((await harness.post(api, fresh.cookie, `/api/auth${alternate}`, {})).statusCode).toBe(
        404,
      );
    }
  });

  it.each(["e2e4", "invalid"])(
    "fences a delayed %s inference, retries and recovery on every device",
    async (uci) => {
      const api = await harness.createAuthenticatedApi();
      const owner = await harness.account(api);
      const second = await owner.anotherSession();
      let calls = 0;
      const gate = gatedAdapter("openai", () => {
        calls++;
      });
      const gameService = service(api, { openai: gate.adapter });
      const { snapshot } = await gameService.createAi(owner.principal, aiMatch);
      const command = turnCommand(snapshot);
      const pending = gameService
        .aiTurn(owner.principal, command, access())
        .catch((error: unknown) => error);
      await gate.entered;
      const before = await gameRecords(api, snapshot.gameId);
      expect((await harness.post(api, second.cookie, path, { confirm: true })).statusCode).toBe(
        200,
      );
      gate.resolve(output(uci));
      await pending;
      expect(calls).toBe(1);
      expect(
        Object.values(
          await gameRecords(
            api,
            snapshot.gameId,
            before.turns.map((turn) => turn.id),
          ),
        ).every((rows) => rows.length === 0),
      ).toBe(true);
      await expect(
        gameService.lifecycle(second.principal, control(snapshot, "pause")),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(gameService.aiTurn(owner.principal, command, access())).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    },
  );
});
