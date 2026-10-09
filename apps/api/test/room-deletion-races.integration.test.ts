import { randomUUID } from "node:crypto";

import { restoreGame } from "@neurochess/chess";
import { gameLifecycleSchema } from "@neurochess/contracts";
import {
  authSessions,
  authUsers,
  gameParticipants,
  games,
  gameSlots,
  roomHistoryAccess,
  rooms,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { persistCommand } from "../src/games/command-persistence.js";
import { GameRequestError } from "../src/games/errors.js";
import { createGameService } from "../src/games/service.js";
import type { Principal } from "../src/identity/principal.js";
import { lockPrincipal, requireActivePrincipal } from "../src/identity/validity.js";

import { FOOLS_MATE, type TestApi } from "./helpers.js";
import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

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

// Exercise the repository protocol before public room commands are enabled in P4-05.
async function writeRoom(
  api: TestApi,
  principal: Principal,
  gameId: string,
  action: "move" | "complete" | "join",
) {
  return api.repository.write(async (tx) => {
    await tx.lockSharedRooms();
    if (!(await lockPrincipal(tx, principal))) throw new GameRequestError("UNAUTHORIZED");
    let game = await tx.lockGame(gameId);
    await requireActivePrincipal(tx, principal);
    if (!game) throw new GameRequestError("NOT_FOUND");
    if (game.state !== (action === "join" ? "paused" : "active")) {
      throw new GameRequestError("INVALID_GAME_STATE");
    }
    if (action === "join") {
      if (principal.kind !== "account") throw new Error("Expected account");
      await tx.seatRoomParticipant(gameId, "black", { userId: principal.userId });
      await tx.reserveGameSlot({ gameId, scope: "ordinary", userId: principal.userId });
      return;
    }
    const restored = restoreGame({
      moves: (await tx.getMoves(gameId)).map((m) => m.uci),
      lifecycle: gameLifecycleSchema.parse({
        state: game.state,
        result: game.result,
        terminationReason: game.terminationReason,
      }),
    });
    if (!restored.ok) throw new Error("Invalid fixture");
    for (const move of action === "move" ? ["e2e4"] : FOOLS_MATE) {
      const accepted = restored.value.playMove(move);
      if (!accepted.ok) throw new Error("Invalid fixture move");
      await persistCommand(tx, game, randomUUID(), "move", accepted.value);
      game = (await tx.getGame(gameId))!;
    }
    await requireActivePrincipal(tx, principal);
  });
}

it.each(["move", "complete", "join"] as const)(
  "account deletion fences a late %s across independent connections",
  async (action) => {
    const { api, owner, opponent, snapshot } = await harness.room({
      state: action === "join" ? "waiting" : "active",
    });
    const other = await harness.createAuthenticatedApi();
    let deletion: ReturnType<typeof harness.post> | undefined;
    let writing: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
      deletion = harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true });
      await blocked(api, pid);
      writing = writeRoom(other, opponent.principal, snapshot.gameId, action).catch(
        (error: unknown) => error,
      );
      await blocked(api, pid, 2);
    });
    expect((await deletion)?.statusCode).toBe(200);
    expect(await writing).toMatchObject({
      code: action === "join" ? "NOT_FOUND" : "INVALID_GAME_STATE",
    });
    expect(await api.database.db.$count(gameSlots, eq(gameSlots.gameId, snapshot.gameId))).toBe(0);
    expect(
      await api.database.db.$count(
        gameParticipants,
        eq(gameParticipants.userId, owner.principal.userId),
      ),
    ).toBe(0);
  },
);

it("keeps a move committed before deletion and preserves its identity-free aborted PGN", async () => {
  const { api, owner, opponent, snapshot, service } = await harness.room({ state: "active" });
  const other = await harness.createAuthenticatedApi();
  let moving: Promise<unknown> | undefined;
  let deleting: ReturnType<typeof harness.post> | undefined;
  await api.database.db.transaction(async (tx) => {
    await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
    const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
      .pid;
    moving = writeRoom(other, owner.principal, snapshot.gameId, "move");
    await blocked(api, pid);
    deleting = harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true });
    await blocked(api, pid, 2);
  });
  await moving;
  expect((await deleting)?.statusCode).toBe(200);
  const retained = (await service.details(opponent.principal, snapshot.gameId)).snapshot;
  expect(retained).toMatchObject({ state: "aborted", version: 2, moves: [{ uci: "e2e4" }] });
  expect(retained.pgn).toContain("1. e4");
  expect(retained.pgn).not.toContain(owner.principal.userId);
});

it.each([true, false])(
  "clear-history observes its gate boundary against opponent completion (completion first: %s)",
  async (completionFirst) => {
    const { api, owner, opponent, snapshot, service } = await harness.room({ state: "active" });
    const other = await harness.createAuthenticatedApi();
    let completing: Promise<unknown> | undefined;
    let clearing: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      const firstIdentity = completionFirst ? opponent.principal : owner.principal;
      if (firstIdentity.kind !== "account") throw new Error("Expected account");
      await tx.select().from(authUsers).where(eq(authUsers.id, firstIdentity.userId)).for("update");
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
      const complete = () => {
        completing = writeRoom(other, opponent.principal, snapshot.gameId, "complete");
      };
      const clear = () => {
        clearing = service.clearHistory(owner.principal, { confirm: true });
      };
      (completionFirst ? complete : clear)();
      await blocked(api, pid);
      (completionFirst ? clear : complete)();
      await blocked(api, pid, 2);
    });
    await Promise.all([completing, clearing]);
    expect((await service.history(owner.principal, { limit: 20 })).games).toHaveLength(
      completionFirst ? 0 : 1,
    );
    expect((await service.history(opponent.principal, { limit: 20 })).games).toHaveLength(1);
  },
);

it.each(["delete", "clear", "account"])(
  "serializes opposing terminal history removals: clear versus %s",
  async (action) => {
    const { api, owner, opponent, snapshot, service } = await harness.room();
    const other = await harness.createAuthenticatedApi();
    const otherService = createGameService(other.repository, {
      nodeEnv: "test",
      sandboxEnabled: false,
    });
    await Promise.all([
      service.clearHistory(owner.principal, { confirm: true }),
      action === "account"
        ? harness
            .post(other, opponent.cookie, "/api/auth/delete-account", { confirm: true })
            .then((r) => expect(r.statusCode).toBe(200))
        : action === "clear"
          ? otherService.clearHistory(opponent.principal, { confirm: true })
          : otherService.deleteGame(opponent.principal, { gameId: snapshot.gameId, confirm: true }),
    ]);
    expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(0);
    expect(
      await api.database.db.$count(
        roomHistoryAccess,
        eq(roomHistoryAccess.gameId, snapshot.gameId),
      ),
    ).toBe(0);
  },
);

it("rolls back shared abort, access, slots and account cascades after a late transaction failure", async () => {
  const { api, owner, opponent, snapshot, service } = await harness.room({ state: "active" });
  const transaction = api.database.db.transaction.bind(api.database.db);
  const fault = vi.spyOn(api.database.db, "transaction").mockImplementation((action, options) =>
    transaction(async (tx) => {
      await action(tx);
      throw new Error("shared-deletion-failure-canary");
    }, options),
  );
  const result = await harness.post(api, owner.cookie, "/api/auth/delete-account", {
    confirm: true,
  });
  fault.mockRestore();
  expect(result.statusCode).toBe(500);
  expect(result.cookies).toEqual([]);
  expect(result.body).not.toContain("canary");
  expect((await service.details(opponent.principal, snapshot.gameId)).snapshot).toEqual(snapshot);
  expect(await api.database.db.$count(gameSlots, eq(gameSlots.gameId, snapshot.gameId))).toBe(2);
  expect(
    await api.database.db.$count(roomHistoryAccess, eq(roomHistoryAccess.gameId, snapshot.gameId)),
  ).toBe(2);
  expect(await api.database.db.$count(authUsers, eq(authUsers.id, owner.principal.userId))).toBe(1);
});

it("rechecks account deletion expiry after the shared gate wait without removing data", async () => {
  const { api, owner, snapshot, service } = await harness.room({ state: "waiting" });
  let pending: ReturnType<typeof harness.post> | undefined;
  await api.repository.write(async (tx) => {
    await tx.lockSharedRooms();
    pending = harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true });
    await expect
      .poll(
        async () =>
          (
            await api.database.db.execute<{ count: number }>(
              sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted`,
            )
          ).rows[0]?.count,
      )
      .toBe(1);
    await api.database.db
      .update(authSessions)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSessions.id, owner.principal.sessionId));
  });
  expect((await pending)?.statusCode).toBe(401);
  expect(await api.repository.read((r) => r.getGame(snapshot.gameId))).toMatchObject({
    state: "paused",
    ownerUserId: owner.principal.userId,
  });
  expect(await api.database.db.$count(rooms, eq(rooms.gameId, snapshot.gameId))).toBe(1);
  await expect(service.details(owner.principal, snapshot.gameId)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
