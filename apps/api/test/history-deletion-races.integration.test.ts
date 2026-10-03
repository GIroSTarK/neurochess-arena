import { randomUUID } from "node:crypto";

import { authSessions, authUsers, games } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";

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
import type { TestApi } from "./helpers.js";
import {
  deletionBody,
  deletionPath,
  gameRecords,
  residualExecution,
  terminalGame,
} from "./history-deletion-helpers.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());
const options = { nodeEnv: "test", sandboxEnabled: true } as const;

async function waitForBlockedOperations(
  observer: Pick<TestApi["database"]["db"], "execute">,
  blockerPid: number,
  count = 1,
) {
  await expect
    .poll(
      async () => {
        await observer.execute(sql`select pg_stat_clear_snapshot()`);
        // Later writers can queue behind the first waiter rather than the original blocker.
        const result = await observer.execute<{ count: number }>(sql`
        with recursive blocked(pid) as (
          select pid from pg_stat_activity where ${blockerPid} = any(pg_blocking_pids(pid))
          union
          select activity.pid from pg_stat_activity activity
            join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
        )
        select count(*)::int as count from blocked
      `);
        return result.rows[0]!.count;
      },
      { timeout: 5_000 },
    )
    .toBe(count);
}

describe("history deletion transactions and concurrency", () => {
  it.each(["individual", "clear"])(
    "rolls back every cascade after an injected %s SQL failure",
    async (operation) => {
      const original = await harness.createAuthenticatedApi();
      const owner = await harness.account(original);
      const snapshots = [
        await terminalGame(harness, original, owner),
        await terminalGame(harness, original, owner, true),
      ];
      await residualExecution(original, snapshots[0]!);
      const before = await Promise.all(
        snapshots.map((snapshot) => gameRecords(original, snapshot.gameId)),
      );
      const failing = await harness.createAuthenticatedApi({
        repository: (repository) => ({
          ...repository,
          write: (action) =>
            repository.write((tx) =>
              action({
                ...tx,
                deleteAccountHistory: async (userId, gameId) => {
                  await tx.deleteAccountHistory(userId, gameId);
                  throw new Error("injected post-delete failure");
                },
              }),
            ),
        }),
      });
      const id = operation === "individual" ? snapshots[0]!.gameId : undefined;
      const response = await harness.post(
        failing,
        owner.cookie,
        deletionPath(id),
        deletionBody(id),
      );
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("injected");
      expect(
        await Promise.all(snapshots.map((snapshot) => gameRecords(original, snapshot.gameId))),
      ).toEqual(before);
    },
  );

  it.each(["individual", "clear"])(
    "rechecks session expiry after a %s game/delete lock wait and rolls back",
    async (operation) => {
      const api = await harness.createAuthenticatedApi();
      const owner = await harness.account(api);
      const snapshot = await terminalGame(harness, api, owner);
      const before = await gameRecords(api, snapshot.gameId);
      const deleting = createGameService(api.repository, options);
      let pending: Promise<unknown> | undefined;
      await api.database.db.transaction(async (tx) => {
        const blocker = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
        pending = (
          operation === "individual"
            ? deleting.deleteGame(owner.principal, deletionBody(snapshot.gameId))
            : deleting.clearHistory(owner.principal, deletionBody())
        ).catch((error: unknown) => error);
        await waitForBlockedOperations(tx, blocker.rows[0]!.pid);
        await tx
          .update(authSessions)
          .set({ expiresAt: new Date(0) })
          .where(eq(authSessions.id, owner.principal.sessionId));
      });
      expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
      expect(await gameRecords(api, snapshot.gameId)).toEqual(before);
    },
  );

  it("rejects clear when the session is revoked while waiting for the account lock", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const snapshot = await terminalGame(harness, api, owner);
    const deleting = createGameService(api.repository, options);
    let pending: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      const blocker = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, owner.principal.userId))
        .for("update");
      pending = deleting
        .clearHistory(owner.principal, deletionBody())
        .catch((error: unknown) => error);
      await waitForBlockedOperations(tx, blocker.rows[0]!.pid);
      await tx.delete(authSessions).where(eq(authSessions.id, owner.principal.sessionId));
    });
    expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
    expect((await gameRecords(api, snapshot.gameId)).games).toHaveLength(1);
  });

  it.each(["clear-first", "completion-first"])(
    "orders concurrent completion and clear at the account lock (%s)",
    async (order) => {
      const api = await harness.createAuthenticatedApi();
      const otherApi = await harness.createAuthenticatedApi();
      const owner = await harness.account(api);
      const previous = await terminalGame(harness, api, owner);
      const { snapshot: active } = await harness.createGame(api, owner.cookie);
      const first = createGameService(api.repository, options);
      const second = createGameService(otherApi.repository, options);
      let initial: Promise<unknown> | undefined;
      let next: Promise<unknown> | undefined;
      await api.database.db.transaction(async (tx) => {
        const blocker = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await tx
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, owner.principal.userId))
          .for("update");
        initial = (
          order === "clear-first"
            ? first.clearHistory(owner.principal, deletionBody())
            : first.lifecycle(owner.principal, control(active, "abort"))
        ).catch((error: unknown) => error);
        await waitForBlockedOperations(tx, blocker.rows[0]!.pid);
        next = (
          order === "clear-first"
            ? second.lifecycle(owner.principal, control(active, "abort"))
            : second.clearHistory(owner.principal, deletionBody())
        ).catch((error: unknown) => error);
        await waitForBlockedOperations(tx, blocker.rows[0]!.pid, 2);
      });
      expect(await initial).toMatchObject(
        order === "clear-first" ? { status: "deleted" } : { state: "aborted" },
      );
      expect(await next).toMatchObject(
        order === "clear-first" ? { state: "aborted" } : { status: "deleted" },
      );
      const history = await second.history(owner.principal, { limit: 20 });
      expect(history.games.map((game) => game.gameId)).toEqual(
        order === "clear-first" ? [active.gameId] : [],
      );
      expect((await gameRecords(api, previous.gameId)).games).toHaveLength(0);
      // An explicit repeat takes a fresh boundary, including games that finished after the first clear.
      await second.clearHistory(owner.principal, deletionBody());
      expect((await second.history(owner.principal, { limit: 20 })).games).toEqual([]);
    },
  );

  it("serializes clear, duplicate deletes and new creation across separate API connections", async () => {
    const api = await harness.createAuthenticatedApi();
    const otherApi = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const snapshot = await terminalGame(harness, api, owner);
    const second = await owner.anotherSession();
    const responses = await Promise.all([
      harness.post(api, owner.cookie, deletionPath(), deletionBody()),
      harness.post(
        otherApi,
        second.cookie,
        deletionPath(snapshot.gameId),
        deletionBody(snapshot.gameId),
      ),
      harness.post(
        api,
        owner.cookie,
        deletionPath(snapshot.gameId.toUpperCase()),
        deletionBody(snapshot.gameId),
      ),
      harness.post(otherApi, second.cookie, "/games", aiMatch),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 201]);
    const unfinished = await createGameService(api.repository, options).unfinishedGame(
      owner.principal,
    );
    expect(unfinished.game?.snapshot.state).toBe("active");
    expect((await gameRecords(api, snapshot.gameId)).games).toHaveLength(0);
  });

  it("lets an already-started read finish consistently, but rejects reads begun after deletion", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const snapshot = await terminalGame(harness, api, owner);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reader = createGameService(
      {
        ...api.repository,
        read: (action) =>
          api.repository.read((tx) =>
            action({
              ...tx,
              getGame: async (id) => {
                const row = await tx.getGame(id);
                entered.resolve();
                await release.promise;
                return row;
              },
            }),
          ),
      },
      options,
    );
    const pending = reader.replay(owner.principal, snapshot.gameId);
    await entered.promise;
    try {
      expect(
        (await harness.post(api, owner.cookie, deletionPath(), deletionBody())).statusCode,
      ).toBe(200);
    } finally {
      release.resolve();
    }
    expect((await pending).snapshot).toEqual(snapshot);
    await expect(reader.replay(owner.principal, snapshot.gameId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("cannot recreate deleted records from a provider result dispatched before Stop", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const gate = gatedAdapter();
    const executor = service(api, { openai: gate.adapter });
    const { snapshot } = await executor.createAi(owner.principal, aiMatch);
    const pending = executor
      .aiTurn(owner.principal, turnCommand(snapshot), access())
      .catch((error: unknown) => error);
    await gate.entered;
    const before = await gameRecords(api, snapshot.gameId);
    try {
      await executor.lifecycle(owner.principal, control(snapshot, "abort"));
      await executor.deleteGame(owner.principal, deletionBody(snapshot.gameId));
    } finally {
      gate.resolve(output("e2e4"));
    }
    expect(await pending).toMatchObject({ code: "NOT_FOUND" });
    const after = await gameRecords(
      api,
      snapshot.gameId,
      before.turns.map((turn) => turn.id),
    );
    expect(Object.values(after).every((rows) => rows.length === 0)).toBe(true);
    expect(gate.adapter.moveCalls).toBe(1);
    await expect(
      executor.deleteGame(owner.principal, { gameId: randomUUID(), confirm: true }),
    ).resolves.toEqual({ status: "deleted" });
  });
});
