import { authUsers, gameParticipants, games, gameSlots, rooms } from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(() => harness.dispose());

it.each(["owner", "opponent"] as const)(
  "deleting the %s aborts play, releases both slots and preserves anonymized opponent history",
  async (which) => {
    const { api, owner, opponent, snapshot, service } = await harness.room({ state: "active" });
    const deleted = which === "owner" ? owner : opponent;
    const remaining = which === "owner" ? opponent : owner;
    if (deleted.principal.kind !== "account") throw new Error("Expected account");
    const response = await harness.post(api, deleted.cookie, "/api/auth/delete-account", {
      confirm: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = await service.details(remaining.principal, snapshot.gameId);
    expect(result.snapshot).toMatchObject({
      state: "aborted",
      result: "*",
      terminationReason: "aborted",
      version: 1,
    });
    expect(await api.database.db.$count(gameSlots, eq(gameSlots.gameId, snapshot.gameId))).toBe(0);
    expect(
      await api.database.db.$count(authUsers, eq(authUsers.id, deleted.principal.userId)),
    ).toBe(0);
    expect(
      await api.database.db.$count(
        gameParticipants,
        eq(gameParticipants.userId, deleted.principal.userId),
      ),
    ).toBe(0);
    expect(await api.repository.read((r) => r.getRoom(snapshot.gameId))).toMatchObject({
      invitationDigest: null,
    });
    const history = await service.history(remaining.principal, { limit: 20 });
    expect(history.games).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain(deleted.principal.userId);
    expect(history.games[0]).toMatchObject({
      players: { [which === "owner" ? "white" : "black"]: { kind: "deleted" } },
    });
  },
);

it("preserves a completed result and ordering while deleting a previously hidden participant", async () => {
  const { api, owner, opponent, snapshot, service } = await harness.room();
  const before = await service.history(opponent.principal, { limit: 20 });
  await service.clearHistory(owner.principal, { confirm: true });
  expect(
    (await harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true }))
      .statusCode,
  ).toBe(200);
  expect((await service.details(opponent.principal, snapshot.gameId)).snapshot).toEqual(snapshot);
  expect((await service.history(opponent.principal, { limit: 20 })).games[0]?.finishedAt).toBe(
    before.games[0]?.finishedAt,
  );
});

it("purges a waiting owner and serializes simultaneous participant deletion across API instances", async () => {
  const waiting = await harness.room({ state: "waiting" });
  expect(
    (
      await harness.post(waiting.api, waiting.owner.cookie, "/api/auth/delete-account", {
        confirm: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    await waiting.api.database.db.$count(rooms, eq(rooms.gameId, waiting.snapshot.gameId)),
  ).toBe(0);
  const { api, owner, opponent, snapshot } = await harness.room({ state: "active" });
  const other = await harness.createAuthenticatedApi();
  const results = await Promise.all([
    harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true }),
    harness.post(other, opponent.cookie, "/api/auth/delete-account", { confirm: true }),
  ]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(0);
  expect(await api.database.db.$count(gameSlots, eq(gameSlots.gameId, snapshot.gameId))).toBe(0);
});
