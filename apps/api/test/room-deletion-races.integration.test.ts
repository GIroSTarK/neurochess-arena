import {
  authSessions,
  authUsers,
  games,
  gameSlots,
  roomHistoryAccess,
  rooms,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { createGameService } from "../src/games/service.js";

import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

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
