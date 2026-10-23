import { authSessions, authUsers, games, providerCredentials } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { AccountGameHarness } from "./account-game-helpers.js";
import {
  aiMatch,
  control,
  createControlledAiGame,
  createTestGameService,
} from "./ai-turn-helpers.js";
import type { TestApi } from "./helpers.js";
import { gameRecords, residualExecution, terminalGame } from "./history-deletion-helpers.js";

const harness = new AccountGameHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});
const path = "/api/auth/delete-account";

async function blocked(tx: Pick<TestApi["database"]["db"], "execute">, pid: number, count = 1) {
  await expect
    .poll(
      async () => {
        await tx.execute(sql`select pg_stat_clear_snapshot()`);
        const result = await tx.execute<{ count: number }>(sql`
      with recursive blocked(pid) as (
        select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        union select a.pid from pg_stat_activity a join blocked b on b.pid = any(pg_blocking_pids(a.pid))
      ) select count(*)::int as count from blocked
    `);
        return result.rows[0]!.count;
      },
      { timeout: 5_000 },
    )
    .toBe(count);
}

it("rolls back every cascade on a commit failure and never clears cookies or reports success", async () => {
  const api = await harness.createAuthenticatedApi();
  const owner = await harness.account(api);
  const game = await terminalGame(harness, api, owner);
  await residualExecution(api, game);
  const before = await gameRecords(api, game.gameId);
  const transaction = api.database.db.transaction.bind(api.database.db);
  const fault = vi.spyOn(api.database.db, "transaction").mockImplementation((action, options) =>
    transaction(async (tx) => {
      await action(tx);
      throw new Error("private-commit-failure-canary");
    }, options),
  );
  const response = await harness.post(api, owner.cookie, path, { confirm: true });
  fault.mockRestore();
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain("canary");
  expect(response.cookies).toEqual([]);
  expect(await gameRecords(api, game.gameId)).toEqual(before);
  expect(
    (
      await api.app.inject({ url: "/api/auth/get-session", headers: { cookie: owner.cookie } })
    ).json(),
  ).not.toBeNull();
  expect((await harness.post(api, owner.cookie, path, { confirm: true })).statusCode).toBe(200);
});

it.each(["account", "game", "credential"])(
  "rechecks identity after waiting on a %s lock and rolls back",
  async (lock) => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const game = await terminalGame(harness, api, owner);
    const before = await gameRecords(api, game.gameId);
    const id = crypto.randomUUID();
    expect(
      (
        await harness.post(api, owner.cookie, "/credentials", {
          credentialId: id,
          provider: "openai",
          label: "Retain on rollback",
          apiKey: "fixture-rollback-key",
          save: true,
        })
      ).statusCode,
    ).toBe(201);
    let pending: ReturnType<typeof harness.post> | undefined;
    await api.database.db.transaction(async (tx) => {
      const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      if (lock === "account") {
        await tx
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, owner.principal.userId))
          .for("update");
      }
      if (lock === "game") {
        await tx.select().from(games).where(eq(games.id, game.gameId)).for("update");
      }
      if (lock === "credential") {
        await tx
          .select()
          .from(providerCredentials)
          .where(eq(providerCredentials.userId, owner.principal.userId))
          .for("update");
      }
      if (lock === "credential") {
        // The auth-user cascade deletes sessions before reaching credentials. Time
        // can still expire during that final cascade, after the last session read.
        await api.database.db
          .update(authSessions)
          .set({ expiresAt: new Date(Date.now() + 700) })
          .where(eq(authSessions.id, owner.principal.sessionId));
      }
      pending = harness.post(api, owner.cookie, path, { confirm: true });
      await blocked(tx, result.rows[0]!.pid);
      if (lock === "credential") await new Promise((resolve) => setTimeout(resolve, 750));
      else {
        await tx
          .update(authSessions)
          .set({ expiresAt: new Date(0) })
          .where(eq(authSessions.id, owner.principal.sessionId));
      }
    });
    expect((await pending)?.statusCode).toBe(401);
    expect(await gameRecords(api, game.gameId)).toEqual(before);
    expect(await api.database.db.$count(authUsers, eq(authUsers.id, owner.principal.userId))).toBe(
      1,
    );
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.userId, owner.principal.userId),
      ),
    ).toBe(1);
  },
);

it("serializes deletion with another instance's commands, controller renewal and paused recovery", async () => {
  const api = await harness.createAuthenticatedApi();
  const other = await harness.createAuthenticatedApi();
  const owner = await harness.account(api);
  const otherDevice = await owner.anotherSession();
  const first = createTestGameService(api);
  const second = createTestGameService(other);
  const {
    details: { snapshot },
    controllerId,
  } = await createControlledAiGame(first, owner.principal, aiMatch, crypto.randomUUID());
  const paused = await first.lifecycle(owner.principal, control(snapshot, "pause", controllerId));
  expect(
    await second.controller(otherDevice.principal, {
      gameId: paused.gameId,
      controllerId,
      action: "heartbeat",
    }),
  ).toEqual(paused);
  let deletion: ReturnType<typeof harness.post> | undefined;
  const commands: Promise<unknown>[] = [];
  await api.database.db.transaction(async (tx) => {
    const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    await tx.select().from(authUsers).where(eq(authUsers.id, owner.principal.userId)).for("update");
    deletion = harness.post(api, owner.cookie, path, { confirm: true });
    await blocked(tx, result.rows[0]!.pid);
    commands.push(
      second
        .lifecycle(otherDevice.principal, control(paused, "resume", controllerId))
        .catch((error: unknown) => error),
    );
    await blocked(tx, result.rows[0]!.pid, 2);
    commands.push(
      second
        .controller(owner.principal, {
          gameId: paused.gameId,
          controllerId,
          action: "heartbeat",
        })
        .catch((error: unknown) => error),
    );
    await blocked(tx, result.rows[0]!.pid, 3);
  });
  expect((await deletion)?.statusCode).toBe(200);
  for (const command of commands) expect(await command).toMatchObject({ code: "UNAUTHORIZED" });
  await expect(second.createAi(otherDevice.principal, aiMatch)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(
    Object.values(await gameRecords(api, snapshot.gameId)).every((rows) => rows.length === 0),
  ).toBe(true);
});
