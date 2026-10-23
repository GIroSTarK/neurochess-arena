import { randomUUID } from "node:crypto";

import { gameHistoryResponseSchema } from "@neurochess/contracts";
import { games, profiles } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { aiMatch, control } from "./ai-turn-helpers.js";
import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(() => harness.dispose());

it.each(["completed", "aborted"] as const)(
  "lists %s rooms for both accounts with current seat labels",
  async (state) => {
    const { api, owner, opponent, snapshot, service } = await harness.room({
      state,
      ownerColor: "black",
    });
    if (opponent.principal.kind !== "account") throw new Error("Expected account");
    for (const [player, username] of [
      [owner, "BlackPlayer"],
      [opponent, "WhitePlayer"],
    ] as const) {
      if (player.principal.kind !== "account") throw new Error("Expected account");
      await api.database.db
        .update(profiles)
        .set({ username, usernameNormalized: username.toLowerCase() })
        .where(eq(profiles.userId, player.principal.userId));
    }
    for (const player of [owner, opponent]) {
      const response = await api.app.inject({
        url: "/games/history?limit=1",
        headers: { cookie: player.cookie },
      });
      expect(response.statusCode).toBe(200);
      const history = gameHistoryResponseSchema.parse(response.json());
      expect(history.games).toHaveLength(1);
      expect(history.games[0]).toMatchObject({
        gameId: snapshot.gameId,
        state,
        players: {
          white: { kind: "account", username: "WhitePlayer" },
          black: { kind: "account", username: "BlackPlayer" },
        },
      });
      expect(history.nextCursor).toBeNull();
      expect(JSON.stringify(history)).not.toContain(owner.principal.userId);
      expect((await service.pgn(player.principal, snapshot.gameId)).pgn).toBe(snapshot.pgn);
    }
    const stranger = await harness.account(api);
    expect((await service.history(stranger.principal, { limit: 20 })).games).toEqual([]);
    for (const suffix of ["", "/details", "/replay", "/pgn"]) {
      expect(
        (
          await api.app.inject({
            url: `/games/${snapshot.gameId}${suffix}`,
            headers: { cookie: stranger.cookie },
          })
        ).statusCode,
      ).toBe(404);
    }
  },
);

it.each(["delete", "clear"])(
  "%s removes only the requester's access, including direct replay and PGN",
  async (action) => {
    const { api, owner, opponent, snapshot, service } = await harness.room();
    const remove = () =>
      action === "clear"
        ? service.clearHistory(owner.principal, { confirm: true })
        : service.deleteGame(owner.principal, { gameId: snapshot.gameId, confirm: true });
    expect(await remove()).toEqual({ status: "deleted" });
    expect(await remove()).toEqual({ status: "deleted" });
    expect((await service.history(owner.principal, { limit: 20 })).games).toEqual([]);
    for (const suffix of ["", "/details", "/replay", "/pgn"]) {
      expect(
        (
          await api.app.inject({
            url: `/games/${snapshot.gameId}${suffix}`,
            headers: { cookie: owner.cookie },
          })
        ).statusCode,
      ).toBe(404);
    }
    expect((await service.details(opponent.principal, snapshot.gameId)).snapshot).toEqual(snapshot);
    expect((await service.history(opponent.principal, { limit: 20 })).games).toHaveLength(1);
    await service.clearHistory(opponent.principal, { confirm: true });
    expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(0);
  },
);

it("denies guest history and preserves guest replay when the final account clears", async () => {
  const { api, owner, opponent, snapshot, service } = await harness.room({ guest: true });
  expect(
    (await api.app.inject({ url: "/games/history", headers: { cookie: opponent.cookie } }))
      .statusCode,
  ).toBe(401);
  await service.clearHistory(owner.principal, { confirm: true });
  expect((await service.pgn(opponent.principal, snapshot.gameId)).pgn).toBe(snapshot.pgn);
});

it("rejects deletion of an unfinished room for either account", async () => {
  const { owner, opponent, snapshot, service } = await harness.room({ state: "active" });
  for (const player of [owner, opponent]) {
    await expect(
      service.deleteGame(player.principal, { gameId: snapshot.gameId, confirm: true }),
    ).rejects.toMatchObject({ code: "INVALID_GAME_STATE" });
  }
});

it("paginates mixed solo/shared ties without duplicates or restoring full histories", async () => {
  const { api, opponent, snapshot, service } = await harness.room({ state: "aborted" });
  if (opponent.principal.kind !== "account") throw new Error("Expected account");
  const stored = await api.repository.read((r) => r.getGame(snapshot.gameId));
  const seats = await api.repository.read((r) => r.getParticipants(snapshot.gameId));
  const ids = [snapshot.gameId];
  const solo = await service.createAi(opponent.principal, aiMatch);
  await service.lifecycle(
    opponent.principal,
    control(solo.snapshot, "abort", solo.snapshot.gameId),
  );
  ids.push(solo.snapshot.gameId);
  for (let index = 0; index < 4; index++) {
    const id = randomUUID();
    ids.push(id);
    await api.repository.write(async (tx) => {
      await tx.insertGame(
        { ...stored!, id, pgn: "history summaries must not restore this PGN" },
        seats.map(({ color, seatType, userId }) => ({ gameId: id, color, seatType, userId })),
      );
      await tx.insertRoom({
        gameId: id,
        ownerColor: "white",
        state: "joined",
        joinedAt: new Date(),
      });
    });
  }
  try {
    for (const id of ids) {
      await api.database.db
        .update(games)
        .set({ updatedAt: sql`'2026-10-01T12:00:00.123456Z'::timestamptz` })
        .where(eq(games.id, id));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.history(opponent.principal, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.games.length).toBeLessThanOrEqual(2);
      seen.push(...page.games.map((game) => game.gameId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids.toSorted().reverse());
  } finally {
    for (const id of ids.slice(1)) await api.database.db.delete(games).where(eq(games.id, id));
  }
});
