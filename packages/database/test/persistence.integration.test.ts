import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  createGameRepository,
  gameParticipants,
  games,
  guestSessions,
  moves,
  gameCommands,
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
  it("backfills pre-existing move identities with the actual forward migration", async () => {
    const schemaName = "migration_" + randomUUID().replaceAll("-", "");
    const oldSql = await readFile(
      new URL("../drizzle/0001_guest_owned_games.sql", import.meta.url),
      "utf8",
    );
    const nextSql = await readFile(
      new URL("../drizzle/0002_game_command_receipts.sql", import.meta.url),
      "utf8",
    );
    const ownerId = randomUUID();
    const gameId = randomUUID();
    const commandId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`create schema ${sql.identifier(schemaName)}`);
      await tx.execute(sql`set local search_path to ${sql.identifier(schemaName)}`);
      for (const statement of oldSql
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim()))
        await tx.execute(sql.raw(statement.replaceAll('"public"', '"' + schemaName + '"')));
      await tx.execute(
        sql`insert into guest_sessions(id, token_hash, expires_at) values (${ownerId}, ${"1".repeat(64)}, clock_timestamp() + interval '1 hour')`,
      );
      await tx.execute(
        sql`insert into games(id, owner_guest_session_id, state, result, fen, pgn, version) values (${gameId}, ${ownerId}, 'active', '*', 'fixture', 'fixture', 1)`,
      );
      await tx.execute(
        sql`insert into moves(game_id, ply, uci, san, fen, command_id, version) values (${gameId}, 1, 'e2e4', 'e4', 'fixture', ${commandId}, 1)`,
      );
      for (const statement of nextSql
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim()))
        await tx.execute(sql.raw(statement.replaceAll('"public"', '"' + schemaName + '"')));
      const receipts = await tx.execute(
        sql`select game_id, command_id, kind, version from game_commands`,
      );
      expect(receipts.rows).toEqual([
        { game_id: gameId, command_id: commandId, kind: "move", version: "1" },
      ]);
      await tx.execute(sql`drop schema ${sql.identifier(schemaName)} cascade`);
    });
  });

  it("enforces receipt identity/version uniqueness and cascades receipts only with their game", async () => {
    const created = await game();
    const other = await game();
    const receipt = {
      gameId: created.id,
      commandId: randomUUID(),
      kind: "pause" as const,
      version: 1,
    };
    await database.db.insert(gameCommands).values(receipt);
    for (const duplicate of [
      { ...receipt, version: 2, kind: "abort" as const },
      { ...receipt, commandId: randomUUID() },
    ])
      await expect(database.db.insert(gameCommands).values(duplicate)).rejects.toThrow();
    await expect(
      database.db.insert(gameCommands).values({ ...receipt, version: 0, commandId: randomUUID() }),
    ).rejects.toThrow();
    await database.db.insert(gameCommands).values({ ...receipt, gameId: other.id });
    await database.db.delete(games).where(eq(games.id, created.id));
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, created.id))).toBe(0);
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, other.id))).toBe(1);
  });

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
