import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  createGameRepository,
  gameParticipants,
  games,
  guestSessions,
  moves,
  runMigrations,
  type DatabaseConnection,
  type NewGame,
  type NewMove,
} from "../src/index.js";

let database: DatabaseConnection;
const guestIds: string[] = [];

beforeAll(() => {
  database = integrationDatabase();
});
afterAll(async () => {
  await database.close();
});
afterEach(async () => {
  if (guestIds.length === 0) return;
  await database.db.transaction(async (tx) => {
    await tx.delete(games).where(inArray(games.ownerGuestSessionId, guestIds));
    await tx.delete(guestSessions).where(inArray(guestSessions.id, guestIds));
  });
  guestIds.length = 0;
});

async function guest() {
  const result = await createGameRepository(database).createGuest(
    createHash("sha256").update(randomUUID()).digest("hex"),
    3600,
  );
  guestIds.push(result.id);
  return result;
}

function gameValues(ownerGuestSessionId: string): NewGame {
  return {
    id: randomUUID(),
    ownerGuestSessionId,
    state: "active",
    result: "*",
    terminationReason: null,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    pgn: '[Result "*"]\n\n*',
  };
}

async function game() {
  const owner = await guest();
  const [created] = await database.db.insert(games).values(gameValues(owner.id)).returning();
  if (!created) throw new Error("Fixture insertion failed");
  return created;
}

function moveValues(gameId: string): NewMove {
  return {
    gameId,
    ply: 1,
    uci: "e2e4",
    san: "e4",
    fen: "position-fixture",
    version: 1,
    commandId: randomUUID(),
  };
}

describe("reviewed PostgreSQL migration and structural constraints", () => {
  it("reapplies migrations without changing persisted data and installs exactly one unfinished-owner index", async () => {
    const created = await game();
    await runMigrations(database);
    await runMigrations(database);
    expect((await database.db.select().from(games).where(eq(games.id, created.id)))[0]).toEqual(
      created,
    );
    const result = await database.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where schemaname = 'public' and indexname = 'games_one_unfinished_per_guest'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.indexdef).toContain("UNIQUE INDEX");
    expect(result.rows[0]!.indexdef).toContain("active");
    expect(result.rows[0]!.indexdef).toContain("paused");
  });

  it("enforces the active/paused slot in PostgreSQL even for direct racing inserts", async () => {
    const owner = await guest();
    const second = integrationDatabase();
    try {
      const results = await Promise.allSettled([
        database.db.insert(games).values(gameValues(owner.id)),
        second.db
          .insert(games)
          .values({ ...gameValues(owner.id), state: "paused", isSandbox: true }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("frees the slot on both completion and abortion and defaults ordinary games to no sandbox authority", async () => {
    const first = await game();
    expect(first.isSandbox).toBe(false);
    await database.db
      .update(games)
      .set({ state: "completed", result: "0-1", terminationReason: "checkmate" })
      .where(eq(games.id, first.id));
    const [second] = await database.db
      .insert(games)
      .values(gameValues(first.ownerGuestSessionId))
      .returning();
    await database.db
      .update(games)
      .set({ state: "aborted", result: "*", terminationReason: "aborted" })
      .where(eq(games.id, second!.id));
    await expect(
      database.db.insert(games).values(gameValues(first.ownerGuestSessionId)),
    ).resolves.toBeDefined();
  });

  it.each([
    { state: "active", result: "1-0", terminationReason: "checkmate" },
    { state: "completed", result: "1-0", terminationReason: null },
    { state: "completed", result: "1/2-1/2", terminationReason: null },
    { state: "completed", result: "*", terminationReason: "checkmate" },
    { state: "completed", result: "1-0", terminationReason: "stalemate" },
    { state: "aborted", result: "*", terminationReason: null },
    { state: "aborted", result: "0-1", terminationReason: "aborted" },
  ] as const)("rejects contradictory lifecycle fields: %j", async (lifecycle) => {
    const owner = await guest();
    await expect(
      database.db.insert(games).values({ ...gameValues(owner.id), ...lifecycle }),
    ).rejects.toThrow();
  });

  it("enforces foreign keys, exclusive colors and a single assigned seat per guest", async () => {
    const created = await game();
    const white = {
      gameId: created.id,
      guestSessionId: created.ownerGuestSessionId,
      color: "white" as const,
      seatType: "human" as const,
    };
    await database.db.insert(gameParticipants).values(white);
    await expect(
      database.db.insert(gameParticipants).values({ ...white, guestSessionId: null }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({ ...white, color: "black" }),
    ).rejects.toThrow();
    await expect(
      database.db
        .insert(gameParticipants)
        .values({ ...white, color: "black", guestSessionId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({ ...white, gameId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({ ...white, color: "black", seatType: "ai" }),
    ).rejects.toThrow();
    await expect(database.db.insert(games).values(gameValues(randomUUID()))).rejects.toThrow();
    await expect(database.db.insert(moves).values(moveValues(randomUUID()))).rejects.toThrow();
  });

  it("enforces per-game move ply, command and aggregate-version uniqueness", async () => {
    const created = await game();
    const accepted = moveValues(created.id);
    await database.db.insert(moves).values(accepted);
    for (const duplicate of [
      { ...accepted, commandId: randomUUID(), version: 2 },
      { ...accepted, ply: 2, version: 2 },
      { ...accepted, commandId: randomUUID(), ply: 2 },
    ])
      await expect(database.db.insert(moves).values(duplicate)).rejects.toThrow();
    const other = await game();
    // Deduplication IDs are scoped to the aggregate, not to all games.
    await expect(
      database.db.insert(moves).values({ ...accepted, gameId: other.id }),
    ).resolves.toBeDefined();
  });

  it("rejects invalid counters and malformed UCI while keeping safe-integer revisions", async () => {
    const created = await game();
    for (const patch of [
      { ply: 0 },
      { version: 0 },
      { version: -1 },
      { version: Number.MAX_SAFE_INTEGER + 1 },
      { uci: "e4" },
      { uci: "e2e2" },
    ]) {
      await expect(
        database.db.insert(moves).values({ ...moveValues(created.id), ...patch }),
      ).rejects.toThrow();
    }
    for (const version of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        database.db.update(games).set({ version }).where(eq(games.id, created.id)),
      ).rejects.toThrow();
    }
    await expect(
      database.db
        .update(games)
        .set({ version: Number.MAX_SAFE_INTEGER })
        .where(eq(games.id, created.id)),
    ).resolves.toBeDefined();
  });

  it("rolls back creation if a participant insertion fails", async () => {
    const owner = await guest();
    const values = gameValues(owner.id);
    const repository = createGameRepository(database);
    await expect(
      repository.write(async (tx) => {
        await tx.lockGuest(owner.id);
        await tx.insertGame(values, [
          { gameId: values.id!, color: "white", seatType: "human", guestSessionId: owner.id },
          { gameId: values.id!, color: "white", seatType: "human", guestSessionId: null },
        ]);
      }),
    ).rejects.toThrow();
    expect(await database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(0);
  });

  it("cascades only the deleted game's participants and moves", async () => {
    const created = await game();
    const other = await game();
    for (const row of [created, other]) {
      await database.db.insert(gameParticipants).values({
        gameId: row.id,
        color: "white",
        seatType: "human",
        guestSessionId: row.ownerGuestSessionId,
      });
      await database.db.insert(moves).values(moveValues(row.id));
    }
    await database.db.delete(games).where(eq(games.id, created.id));
    expect(await database.db.$count(moves, eq(moves.gameId, created.id))).toBe(0);
    expect(
      await database.db.$count(gameParticipants, eq(gameParticipants.gameId, created.id)),
    ).toBe(0);
    expect(await database.db.$count(moves, eq(moves.gameId, other.id))).toBe(1);
    expect(
      await database.db.$count(
        guestSessions,
        and(eq(guestSessions.id, created.ownerGuestSessionId)),
      ),
    ).toBe(1);
  });
});
