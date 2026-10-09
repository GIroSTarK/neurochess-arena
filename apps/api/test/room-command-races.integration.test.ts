import { randomUUID } from "node:crypto";

import { gameSnapshotSchema } from "@neurochess/contracts";
import { authUsers, games, gameSlots } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { command, FOOLS_MATE, type TestApi } from "./helpers.js";
import { RoomApiHarness } from "./room-api-helpers.js";

const harness = new RoomApiHarness();
afterEach(() => harness.dispose());

async function blocked(api: TestApi, pid: number, count = 1) {
  await expect
    .poll(
      async () =>
        (
          await api.database.db.execute<{ count: number }>(sql`
      with recursive blocked(pid) as (
        select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        union select a.pid from pg_stat_activity a join blocked b on b.pid = any(pg_blocking_pids(a.pid))
      ) select count(*)::int as count from blocked
    `)
        ).rows[0]?.count,
    )
    .toBe(count);
}

it.each([true, false])(
  "serializes the public move path with account deletion (move first: %s)",
  async (moveFirst) => {
    const { api, owner, invitation } = await harness.room("black");
    const other = await harness.createAuthenticatedApi();
    const opponent = await harness.account(api);
    const { snapshot } = await harness.join(api, opponent.cookie, invitation, randomUUID());
    const gameId = snapshot.gameId;
    let moving: ReturnType<typeof harness.post> | undefined;
    let deleting: ReturnType<typeof harness.post> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx.select().from(games).where(eq(games.id, gameId)).for("update");
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
      const move = () => {
        moving = harness.post(
          other,
          opponent.cookie,
          `/games/${gameId}/moves`,
          command(snapshot, "e2e4"),
        );
      };
      const remove = () => {
        deleting = harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true });
      };
      (moveFirst ? move : remove)();
      await blocked(api, pid);
      (moveFirst ? remove : move)();
      await blocked(api, pid, 2);
    });
    expect((await deleting)?.statusCode).toBe(200);
    expect((await moving)?.statusCode).toBe(moveFirst ? 200 : 409);
    if (!moveFirst) {
      expect((await moving)?.json()).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: { state: "aborted" },
      });
    }
    const retained = await harness.view(api, opponent.cookie, gameId);
    expect(retained.players.black).toEqual({ kind: "deleted" });
    expect(retained.snapshot).toMatchObject({ state: "aborted", version: moveFirst ? 3 : 2 });
    expect(retained.snapshot.moves.map((move) => move.uci)).toEqual(moveFirst ? ["e2e4"] : []);
    expect(await api.database.db.$count(gameSlots, eq(gameSlots.gameId, gameId))).toBe(0);
  },
);

it.each([true, false])(
  "serializes public checkmate with the other account's clear-history boundary (mate first: %s)",
  async (mateFirst) => {
    const { api, owner, invitation } = await harness.room();
    const other = await harness.createAuthenticatedApi();
    const opponent = await harness.account(api);
    let { snapshot } = await harness.join(api, opponent.cookie, invitation, randomUUID());
    const gameId = snapshot.gameId;
    for (const move of FOOLS_MATE.slice(0, 3)) {
      const response = await harness.post(
        api,
        snapshot.turn === "white" ? owner.cookie : opponent.cookie,
        `/games/${gameId}/moves`,
        command(snapshot, move),
      );
      expect(response.statusCode).toBe(200);
      snapshot = gameSnapshotSchema.parse(response.json());
    }
    let completing: ReturnType<typeof harness.post> | undefined;
    let clearing: ReturnType<typeof harness.post> | undefined;
    await api.database.db.transaction(async (tx) => {
      const first = mateFirst ? opponent.principal : owner.principal;
      await tx.select().from(authUsers).where(eq(authUsers.id, first.userId)).for("update");
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
      const mate = () => {
        completing = harness.post(
          other,
          opponent.cookie,
          `/games/${gameId}/moves`,
          command(snapshot, "d8h4"),
        );
      };
      const clear = () => {
        clearing = harness.post(api, owner.cookie, "/games/history/clear", { confirm: true });
      };
      (mateFirst ? mate : clear)();
      await blocked(api, pid);
      (mateFirst ? clear : mate)();
      await blocked(api, pid, 2);
    });
    expect((await completing)?.statusCode).toBe(200);
    expect((await clearing)?.statusCode).toBe(200);
    expect((await harness.view(api, opponent.cookie, gameId)).snapshot).toMatchObject({
      state: "completed",
      terminationReason: "checkmate",
    });
    const ownerRead = await api.app.inject({
      url: `/rooms/${gameId}`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerRead.statusCode).toBe(mateFirst ? 404 : 200);
  },
);
