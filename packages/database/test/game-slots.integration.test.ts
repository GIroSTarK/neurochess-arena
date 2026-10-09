import { createHash, randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  authUsers,
  createGameRepository,
  gameParticipants,
  games,
  gameSlots,
  guestSessions,
  type NewGame,
  type NewParticipant,
} from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const database = integrationDatabase();
  const otherDatabase = integrationDatabase();
  const repository = createGameRepository(database);
  const otherRepository = createGameRepository(otherDatabase);
  const accounts = [randomUUID(), randomUUID(), randomUUID()];
  const gameIds: string[] = [];
  await database.db
    .insert(authUsers)
    .values(accounts.map((id) => ({ id, name: "", email: `${id}@example.com` })));
  const guest = await repository.createGuest(
    createHash("sha256").update(randomUUID()).digest("hex"),
    3600,
  );
  cleanups.push(async () => {
    try {
      if (gameIds.length) await database.db.delete(games).where(inArray(games.id, gameIds));
      await database.db.delete(authUsers).where(inArray(authUsers.id, accounts));
      await database.db.delete(guestSessions).where(eq(guestSessions.id, guest.id));
    } finally {
      await Promise.all([database.close(), otherDatabase.close()]);
    }
  });
  function values(patch: Partial<NewGame> = {}): NewGame & { id: string } {
    const id = randomUUID();
    gameIds.push(id);
    return {
      ownerUserId: accounts[0]!,
      mode: "human_vs_human",
      state: "active",
      result: "*",
      fen: "structural-position",
      pgn: "structural-history",
      ...patch,
      id,
    };
  }
  function seats(game: NewGame & { id: string }, opponent: Partial<NewParticipant> = {}) {
    return [
      { gameId: game.id, color: "white", seatType: "human", userId: game.ownerUserId },
      { gameId: game.id, color: "black", seatType: "human", ...opponent },
    ] satisfies NewParticipant[];
  }
  return { database, repository, otherRepository, accounts, guest, values, seats };
}

describe("participant unfinished game slots", () => {
  it.each(["account", "guest"] as const)(
    "arbitrates concurrent ordinary %s creations with a seatless AI owner",
    async (kind) => {
      const { database, repository, otherRepository, accounts, guest, values } = await fixture();
      const owner =
        kind === "account"
          ? { ownerUserId: accounts[0]! }
          : { ownerUserId: null, ownerGuestSessionId: guest.id };
      const first = values({ ...owner, mode: "ai_vs_ai" });
      const second = values({ ...owner, mode: "ai_vs_human", state: "paused" });
      const results = await Promise.allSettled([
        repository.write((tx) => tx.insertGame(first, [])),
        otherRepository.write((tx) => tx.insertGame(second, [])),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { cause: { code: "23505" } },
      });
      expect(
        await database.db.$count(gameSlots, inArray(gameSlots.gameId, [first.id, second.id])),
      ).toBe(1);
      expect(await database.db.$count(games, inArray(games.id, [first.id, second.id]))).toBe(1);
    },
  );

  it.each(["account", "guest"] as const)(
    "arbitrates AI creation versus a %s room-admission reservation without application serialization",
    async (kind) => {
      const { database, repository, otherRepository, accounts, guest, values, seats } =
        await fixture();
      const room = values({ state: "paused" });
      await repository.write(async (tx) => {
        await tx.insertGame(room, seats(room));
        await tx.insertRoom({
          gameId: room.id,
          ownerColor: "white",
          state: "waiting",
          invitationDigest: "a".repeat(64),
        });
      });
      const identity = kind === "account" ? { userId: accounts[1]! } : { guestSessionId: guest.id };
      const ai = values({
        ownerUserId: kind === "account" ? accounts[1]! : null,
        ownerGuestSessionId: kind === "guest" ? guest.id : null,
        mode: "ai_vs_ai",
      });
      const results = await Promise.allSettled([
        repository.write((tx) => tx.insertGame(ai, [])),
        otherRepository.write((tx) =>
          tx.reserveGameSlot({ gameId: room.id, scope: "ordinary", ...identity }),
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { cause: { code: "23505" } },
      });
      const occupied =
        kind === "account"
          ? await repository.read((r) => r.findUnfinishedAccountGame(accounts[1]!))
          : await repository.read((r) => r.findUnfinishedGame(guest.id, "ordinary"));
      expect(occupied?.id).toBe(results[0].status === "fulfilled" ? ai.id : room.id);
      expect(await database.db.$count(games, eq(games.id, ai.id))).toBe(
        results[0].status === "fulfilled" ? 1 : 0,
      );
      expect(await repository.read((r) => r.getRoom(room.id))).toMatchObject({
        state: "waiting",
        invitationDigest: "a".repeat(64),
      });
      expect(await database.db.$count(gameParticipants, eq(gameParticipants.gameId, room.id))).toBe(
        2,
      );
    },
  );

  it("rolls back reservations and game/seat creation together and reuses the identity afterward", async () => {
    const { database, repository, accounts, values, seats } = await fixture();
    const room = values();
    await expect(
      repository.write(async (tx) => {
        await tx.insertGame(room, seats(room, { userId: accounts[1]! }));
        expect(await tx.findUnfinishedAccountGame(accounts[1]!)).toMatchObject({ id: room.id });
        throw new Error("rollback after reservation");
      }),
    ).rejects.toThrow("rollback after reservation");
    expect(await database.db.$count(games, eq(games.id, room.id))).toBe(0);
    expect(await database.db.$count(gameParticipants, eq(gameParticipants.gameId, room.id))).toBe(
      0,
    );
    expect(await database.db.$count(gameSlots, eq(gameSlots.gameId, room.id))).toBe(0);
    await repository.write((tx) => tx.insertGame(room, seats(room, { userId: accounts[1]! })));
    expect(await database.db.$count(gameSlots, eq(gameSlots.gameId, room.id))).toBe(2);
  });

  it("enforces exclusive existing identities and independent guest scopes at the SQL boundary", async () => {
    const { database, repository, accounts, guest, values, seats } = await fixture();
    const room = values({ state: "paused" });
    await repository.write((tx) => tx.insertGame(room, seats(room, { guestSessionId: guest.id })));
    for (const identity of [
      {},
      { userId: accounts[1]!, guestSessionId: guest.id },
      { userId: randomUUID() },
      { guestSessionId: randomUUID() },
    ]) {
      await expect(
        database.db.insert(gameSlots).values({ gameId: room.id, scope: "ordinary", ...identity }),
      ).rejects.toThrow();
    }
    await expect(
      database.db
        .insert(gameSlots)
        .values({ gameId: randomUUID(), scope: "ordinary", userId: accounts[1]! }),
    ).rejects.toThrow();
    await expect(
      database.db
        .insert(gameSlots)
        .values({ gameId: room.id, scope: "sandbox", userId: accounts[1]! }),
    ).rejects.toThrow();
    await expect(
      database.db.execute(
        sql`insert into game_slots(game_id, scope, user_id) values (${room.id}, 'unknown', ${accounts[1]})`,
      ),
    ).rejects.toThrow();
    const sandbox = values({
      ownerUserId: null,
      ownerGuestSessionId: guest.id,
      mode: null,
      isSandbox: true,
    });
    await repository.write((tx) => tx.insertGame(sandbox, []));
    expect(await repository.read((r) => r.findUnfinishedGame(guest.id, "sandbox"))).toMatchObject({
      id: sandbox.id,
    });
    await database.db.delete(games).where(eq(games.id, room.id));
    expect(
      await repository.read((r) => r.findUnfinishedGame(guest.id, "ordinary")),
    ).toBeUndefined();
    expect(await repository.read((r) => r.findUnfinishedGame(guest.id, "sandbox"))).toMatchObject({
      id: sandbox.id,
    });
  });

  it("does not reserve terminal games and rejects explicit reservations for terminal or mismatched scopes", async () => {
    const { database, repository, accounts, values, seats } = await fixture();
    const room = values({ state: "aborted", terminationReason: "aborted" });
    await repository.write((tx) => tx.insertGame(room, seats(room, { userId: accounts[1]! })));
    expect(await database.db.$count(gameSlots, eq(gameSlots.gameId, room.id))).toBe(0);
    await expect(
      repository.write((tx) =>
        tx.reserveGameSlot({ gameId: room.id, scope: "ordinary", userId: accounts[1]! }),
      ),
    ).rejects.toThrow("unfinished game");
    const active = values();
    await repository.write((tx) => tx.insertGame(active, seats(active)));
    await expect(
      repository.write((tx) =>
        tx.reserveGameSlot({ gameId: active.id, scope: "sandbox", userId: accounts[1]! }),
      ),
    ).rejects.toThrow("matching scope");
  });

  it.each([
    { state: "completed", result: "1-0", terminationReason: "checkmate" },
    { state: "completed", result: "1/2-1/2", terminationReason: "threefold_repetition" },
    { state: "completed", result: "0-1", terminationReason: "human_resignation" },
    { state: "completed", result: "1-0", terminationReason: "model_technical_loss" },
    { state: "aborted", result: "*", terminationReason: "aborted" },
  ] as const)("releases every slot on $terminationReason and permits new games", async (ending) => {
    const { database, repository, accounts, values, seats } = await fixture();
    const room = values();
    await repository.write((tx) => tx.insertGame(room, seats(room, { userId: accounts[1]! })));
    expect(await database.db.$count(gameSlots, eq(gameSlots.gameId, room.id))).toBe(2);
    await repository.write(async (tx) => {
      await tx.lockGame(room.id);
      expect(
        await tx.updatePosition(room.id, 0, {
          ...ending,
          fen: "terminal-position",
          pgn: "terminal-history",
          version: 1,
        }),
      ).toBe(true);
    });
    expect(await database.db.$count(gameSlots, eq(gameSlots.gameId, room.id))).toBe(0);
    for (const userId of accounts.slice(0, 2)) {
      expect(await repository.read((r) => r.findUnfinishedAccountGame(userId))).toBeUndefined();
      await repository.write((tx) =>
        tx.insertGame(values({ ownerUserId: userId, mode: "ai_vs_ai" }), []),
      );
    }
  });

  it("retains all slots on stale writes and rolled-back terminal changes, and cascades them on physical deletion", async () => {
    const { database, repository, accounts, values, seats } = await fixture();
    const room = values();
    await repository.write((tx) => tx.insertGame(room, seats(room, { userId: accounts[1]! })));
    const terminal = {
      state: "aborted",
      result: "*",
      terminationReason: "aborted",
      fen: "end",
      pgn: "end",
      version: 1,
    } as const;
    expect(await repository.write((tx) => tx.updatePosition(room.id, 99, terminal))).toBe(false);
    await expect(
      repository.write(async (tx) => {
        expect(await tx.updatePosition(room.id, 0, terminal)).toBe(true);
        expect(await tx.findUnfinishedAccountGame(accounts[1]!)).toBeUndefined();
        expect(await tx.getGame(room.id)).toMatchObject({ state: "aborted" });
        throw new Error("rollback after terminal write");
      }),
    ).rejects.toThrow("rollback after terminal write");
    expect(await database.db.$count(gameSlots, eq(gameSlots.gameId, room.id))).toBe(2);
    expect(await repository.read((r) => r.findUnfinishedAccountGame(accounts[1]!))).toMatchObject({
      id: room.id,
      state: "active",
      version: 0,
    });
    await database.db.delete(games).where(eq(games.id, room.id));
    expect(await database.db.$count(gameSlots, eq(gameSlots.gameId, room.id))).toBe(0);
    await repository.write((tx) =>
      tx.insertGame(values({ ownerUserId: accounts[1]!, mode: "ai_vs_ai" }), []),
    );
  });

  it.each(["active", "paused"] as const)(
    "recovers a non-owner account and guest in an %s room",
    async (state) => {
      const { repository, otherRepository, accounts, guest, values, seats } = await fixture();
      const accountRoom = values({ state });
      await repository.write((tx) =>
        tx.insertGame(accountRoom, seats(accountRoom, { userId: accounts[1]! })),
      );
      expect(
        await otherRepository.read((r) => r.findUnfinishedAccountGame(accounts[1]!)),
      ).toMatchObject({ id: accountRoom.id, state });
      const guestRoom = values({ state, ownerUserId: accounts[2]! });
      await repository.write((tx) =>
        tx.insertGame(guestRoom, seats(guestRoom, { guestSessionId: guest.id })),
      );
      expect(
        await otherRepository.read((r) => r.findUnfinishedGame(guest.id, "ordinary")),
      ).toMatchObject({ id: guestRoom.id, state });
      expect(
        await otherRepository.read((r) => r.findUnfinishedGame(guest.id, "sandbox")),
      ).toBeUndefined();
    },
  );

  it("arbitrates two rooms for the same participant across independent connections without partial games or seats", async () => {
    const { database, repository, otherRepository, accounts, values, seats } = await fixture();
    const first = values();
    const second = values({ ownerUserId: accounts[1]! });
    const results = await Promise.allSettled(
      [repository, otherRepository].map((repo, index) => {
        const game = index === 0 ? first : second;
        return repo.write((tx) => tx.insertGame(game, seats(game, { userId: accounts[2]! })));
      }),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected).toMatchObject({ reason: { cause: { code: "23505" } } });
    expect(await database.db.$count(games, inArray(games.id, [first.id, second.id]))).toBe(1);
    expect(
      await database.db.$count(
        gameParticipants,
        inArray(gameParticipants.gameId, [first.id, second.id]),
      ),
    ).toBe(2);
  });
});
