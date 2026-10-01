import { randomUUID } from "node:crypto";

import { aiTurns, authSessions, authUsers, games, modelInvocations } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGameService } from "../src/games/service.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { access, aiMatch, output, turnCommand } from "./ai-turn-helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { turnCatalog, withTurnCatalog } from "./providers/turn-catalog.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

describe("account session dispatch and revocation races", () => {
  it("rejects game creation after the session is revoked during an account lock wait", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const locking = Promise.withResolvers<void>();
    const service = createGameService(
      {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              lockAccount: (id) => {
                locking.resolve();
                return tx.lockAccount(id);
              },
            }),
          ),
      },
      { nodeEnv: "test", sandboxEnabled: true },
    );
    let pending: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, account.principal.userId))
        .for("update");
      pending = service.createAi(account.principal, aiMatch).catch((error: unknown) => error);
      await locking.promise;
      await tx.delete(authSessions).where(eq(authSessions.id, account.principal.sessionId));
    });
    expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      await api.database.db.$count(games, eq(games.ownerUserId, account.principal.userId)),
    ).toBe(0);
  });

  it("does not accept another account's session ID or account authority for Sandbox", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const service = createGameService(api.repository, { nodeEnv: "test", sandboxEnabled: true });
    await expect(
      service.createAi({ ...owner.principal, sessionId: other.principal.sessionId }, aiMatch),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(service.createSandbox(owner.principal)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.unfinished(owner.principal)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const guest = await harness.guest(api);
    const cookie = `${owner.cookie}; ${guest.cookie}`;
    const disabled = await harness.createAuthenticatedApi({ sandboxEnabled: false });
    expect((await harness.post(disabled, cookie, "/sandbox/games", {})).statusCode).toBe(404);
  });

  it.each([
    { timezone: "Pacific/Kiritimati", lifetime: 3_600_000, valid: true },
    { timezone: "Pacific/Honolulu", lifetime: -3_600_000, valid: false },
  ])(
    "checks UTC account expiry independently of the database timezone ($timezone)",
    async ({ timezone, lifetime, valid }) => {
      const api = await harness.createAuthenticatedApi();
      const account = await harness.account(api);
      const { snapshot } = await harness.createGame(api, account.cookie);
      await api.database.db
        .update(authSessions)
        .set({ expiresAt: new Date(Date.now() + lifetime) })
        .where(eq(authSessions.id, account.principal.sessionId));
      const originalTransaction = api.database.db.transaction.bind(api.database.db);
      const configured = vi
        .spyOn(api.database.db, "transaction")
        .mockImplementation((action, config) =>
          originalTransaction(async (tx) => {
            await tx.execute(sql`select set_config('TimeZone', ${timezone}, true)`);
            return action(tx);
          }, config),
        );
      try {
        const service = createGameService(api.repository, {
          nodeEnv: "test",
          sandboxEnabled: true,
        });
        const read = service.snapshot(account.principal, snapshot.gameId);
        if (valid) expect(await read).toEqual(snapshot);
        else await expect(read).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      } finally {
        configured.mockRestore();
      }
    },
  );

  it("rechecks after discovery and dispatches no inference for a signed-out session", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [
        async () => {
          entered.resolve();
          await release.promise;
          return { ok: true, models: turnCatalog("openai") };
        },
      ],
      moves: [output("e2e4")],
    });
    const api = await harness.createAuthenticatedApi({ aiAdapters: { openai: adapter } });
    const account = await harness.account(api);
    const { snapshot } = await harness.createGame(api, account.cookie);
    const service = createGameService(api.repository, {
      nodeEnv: "test",
      sandboxEnabled: true,
      aiAdapters: { openai: adapter },
    });
    await service.controller(account.principal, {
      gameId: snapshot.gameId,
      action: "acquire",
      expectedVersion: 0,
      controllerId: snapshot.gameId,
    });
    const pending = service
      .aiTurn(account.principal, turnCommand(snapshot), access())
      .catch((error: unknown) => error);
    await entered.promise;
    try {
      expect((await harness.post(api, account.cookie, "/api/auth/sign-out", {})).statusCode).toBe(
        200,
      );
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
    expect(adapter.moveCalls).toBe(0);
    const [turn] = await api.database.db
      .select()
      .from(aiTurns)
      .where(eq(aiTurns.gameId, snapshot.gameId));
    expect(turn?.attemptCount).toBe(0);
  });

  it("retains the invalid-output budget but prevents a retry after sign-out", async () => {
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const { snapshot } = await harness.createGame(api, account.cookie);
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [
        {
          ok: false,
          error: { code: "model_invalid", reason: "illegal_move" },
          durationMs: 1,
          usage: null,
          providerRequestId: null,
        },
        output("e2e4"),
      ],
    });
    const service = createGameService(
      {
        ...api.repository,
        write: async (action) => {
          const outcome = { invalid: false };
          const result = await api.repository.write((tx) =>
            action({
              ...tx,
              incrementAiInvalidCount: async (id) => {
                outcome.invalid = true;
                return tx.incrementAiInvalidCount(id);
              },
            }),
          );
          if (outcome.invalid) {
            observed.resolve();
            await release.promise;
          }
          return result;
        },
      },
      { nodeEnv: "test", sandboxEnabled: true, aiAdapters: { openai: withTurnCatalog(adapter) } },
    );
    await service.controller(account.principal, {
      gameId: snapshot.gameId,
      action: "acquire",
      expectedVersion: 0,
      controllerId: snapshot.gameId,
    });
    const pending = service
      .aiTurn(account.principal, turnCommand(snapshot), access())
      .catch((error: unknown) => error);
    await observed.promise;
    try {
      expect((await harness.post(api, account.cookie, "/api/auth/sign-out", {})).statusCode).toBe(
        200,
      );
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
    expect(adapter.moveCalls).toBe(1);
    const [turn] = await api.database.db
      .select()
      .from(aiTurns)
      .where(eq(aiTurns.gameId, snapshot.gameId));
    expect(turn).toMatchObject({ invalidOutputCount: 1, attemptCount: 1 });
    expect(
      await api.database.db.$count(modelInvocations, eq(modelInvocations.turnId, turn!.id)),
    ).toBe(1);
  });

  it("serializes sign-out behind an in-progress account command without extending another session's authority", async () => {
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const other = await account.anotherSession();
    const { snapshot } = await harness.createGame(api, account.cookie);
    const service = createGameService(
      {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              lockGame: async (id) => {
                const game = await tx.lockGame(id);
                holding.resolve();
                await release.promise;
                return game;
              },
            }),
          ),
      },
      { nodeEnv: "test", sandboxEnabled: true },
    );
    const command = service.lifecycle(account.principal, {
      gameId: snapshot.gameId,
      expectedVersion: 0,
      commandId: randomUUID(),
      action: "pause",
    });
    await holding.promise;
    const state = { signedOut: false };
    const signOut = harness.post(api, account.cookie, "/api/auth/sign-out", {}).then((response) => {
      state.signedOut = true;
      return response;
    });
    try {
      await vi.waitFor(
        async () => {
          const waiting = await api.database.db.execute(sql`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like '%"user"%' and pid <> pg_backend_pid()
        `);
          expect(state.signedOut || Number(waiting.rows[0]?.count) > 0).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(state.signedOut).toBe(false);
      release.resolve();
      expect(await command).toMatchObject({ state: "paused", version: 1 });
      expect((await signOut).statusCode).toBe(200);
    } finally {
      release.resolve();
      await Promise.allSettled([command, signOut]);
    }
    await expect(service.snapshot(account.principal, snapshot.gameId)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await service.snapshot(other.principal, snapshot.gameId)).toMatchObject({
      state: "paused",
      version: 1,
    });
  });
});
