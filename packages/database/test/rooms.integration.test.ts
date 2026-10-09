import { createHash, randomBytes, randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  authUsers,
  createGameRepository,
  gameParticipants,
  games,
  guestSessions,
} from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const database = integrationDatabase();
  const repository = createGameRepository(database);
  const userId = randomUUID();
  const gameIds: string[] = [];
  const guest = await repository.createGuest(
    createHash("sha256").update(randomUUID()).digest("hex"),
    3600,
  );
  await database.db
    .insert(authUsers)
    .values({ id: userId, name: "", email: `${userId}@example.com` });
  cleanups.push(async () => {
    try {
      if (gameIds.length) await database.db.delete(games).where(inArray(games.id, gameIds));
      await database.db.delete(authUsers).where(eq(authUsers.id, userId));
      await database.db.delete(guestSessions).where(eq(guestSessions.id, guest.id));
    } finally {
      await database.close();
    }
  });
  const game = async (patch: Partial<typeof games.$inferInsert> = {}) => {
    const id = randomUUID();
    gameIds.push(id);
    await repository.write((tx) =>
      tx.insertGame(
        {
          id,
          mode: "human_vs_human",
          ownerUserId: userId,
          state: "paused",
          result: "*",
          fen: "structural-position",
          pgn: "structural-history",
          ...patch,
        },
        [
          { gameId: id, color: "white", seatType: "human", userId },
          { gameId: id, color: "black", seatType: "human" },
        ],
      ),
    );
    return id;
  };
  return { database, repository, userId, guest, game };
}

describe("private room persistence foundations", () => {
  it("persists one room per canonical game with digest-only admission and two unique human seats", async () => {
    const { database, repository, game, userId, guest } = await fixture();
    const gameId = await game();
    const raw = randomBytes(32).toString("base64url");
    const invitationDigest = createHash("sha256").update(raw).digest("hex");
    await repository.write((tx) =>
      tx.insertRoom({ gameId, ownerColor: "white", state: "waiting", invitationDigest }),
    );
    const stored = await repository.read((reader) => reader.getRoom(gameId));
    expect(stored).toMatchObject({
      gameId,
      ownerColor: "white",
      state: "waiting",
      invitationDigest,
      joinedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain(raw);
    await expect(
      repository.write((tx) => tx.insertRoom({ gameId, ownerColor: "white", state: "waiting" })),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({ gameId, color: "white", seatType: "human" }),
    ).rejects.toThrow();
    await expect(
      database.db
        .update(gameParticipants)
        .set({ userId })
        .where(sql`${gameParticipants.gameId} = ${gameId} and ${gameParticipants.color} = 'black'`),
    ).rejects.toThrow();
    await database.db
      .update(gameParticipants)
      .set({ guestSessionId: guest.id })
      .where(sql`${gameParticipants.gameId} = ${gameId} and ${gameParticipants.color} = 'black'`);
    await expect(
      database.db
        .update(gameParticipants)
        .set({ userId: null, guestSessionId: guest.id })
        .where(sql`${gameParticipants.gameId} = ${gameId} and ${gameParticipants.color} = 'white'`),
    ).rejects.toThrow();
    await database.db.delete(games).where(eq(games.id, gameId));
    expect(await repository.read((reader) => reader.getRoom(gameId))).toBeUndefined();
  });

  it("rejects raw invitations, unknown metadata and inconsistent joined admission", async () => {
    const { database, repository, game } = await fixture();
    const gameId = await game();
    for (const patch of [
      { invitationDigest: randomBytes(32).toString("base64url") },
      { invitation: "raw-invitation-must-not-persist" },
      { state: "joined", invitationDigest: "a".repeat(64), joinedAt: new Date() },
      { state: "joined" },
      { state: "waiting", joinedAt: new Date() },
    ]) {
      await expect(
        repository.write((tx) =>
          tx.insertRoom({ gameId, ownerColor: "black", state: "waiting", ...patch } as Parameters<
            typeof tx.insertRoom
          >[0]),
        ),
      ).rejects.toThrow();
    }
    // Direct database writes must also reject a raw link/code in the digest column.
    await expect(
      database.db.execute(
        sql`insert into rooms(game_id, owner_color, state, invitation_digest) values (${gameId}, 'white', 'waiting', 'raw-invitation')`,
      ),
    ).rejects.toThrow();
    await repository.write((tx) =>
      tx.insertRoom({ gameId, ownerColor: "black", state: "joined", joinedAt: new Date() }),
    );
    expect(await repository.read((reader) => reader.getRoom(gameId))).toMatchObject({
      state: "joined",
      invitationDigest: null,
    });
  });

  it("allows ownerless terminal human records without weakening solo or unfinished ownership", async () => {
    const { game, guest } = await fixture();
    for (const patch of [
      { ownerUserId: null },
      { ownerUserId: null, ownerGuestSessionId: guest.id },
      { ownerUserId: null, mode: null, state: "aborted", terminationReason: "aborted" },
      { ownerUserId: null, mode: "ai_vs_ai", state: "aborted", terminationReason: "aborted" },
      { isSandbox: true },
    ] as const) {
      await expect(game(patch)).rejects.toThrow();
    }
    await expect(
      game({ ownerUserId: null, state: "aborted", terminationReason: "aborted" }),
    ).resolves.toBeTypeOf("string");
    await expect(
      game({
        ownerUserId: null,
        state: "completed",
        result: "1-0",
        terminationReason: "human_resignation",
      }),
    ).resolves.toBeTypeOf("string");
  });

  it("bounds account creation operations and retains consumed/unavailable results after game cleanup", async () => {
    const { database, repository, game, userId } = await fixture();
    const gameId = await game();
    const operationId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 600_000);
    const operation = {
      userId,
      operationId,
      issuedAt,
      expiresAt,
      state: "consumed" as const,
      ownerColor: "white" as const,
      gameId,
    };
    await repository.write((tx) => tx.insertRoomCreationOperation(operation));
    await expect(
      repository.write((tx) =>
        tx.insertRoomCreationOperation({ ...operation, operationId: randomUUID() }),
      ),
    ).rejects.toThrow();
    await expect(
      database.db.execute(
        sql`update room_creation_operations set expires_at = issued_at + interval '11 minutes' where user_id = ${userId}`,
      ),
    ).rejects.toThrow();
    await expect(
      database.db.execute(
        sql`update room_creation_operations set state = 'pending' where user_id = ${userId}`,
      ),
    ).rejects.toThrow();
    await database.db.delete(games).where(eq(games.id, gameId));
    expect(
      await repository.read((reader) => reader.getRoomCreationOperation(userId)),
    ).toMatchObject({
      operationId,
      state: "consumed",
      ownerColor: "white",
      gameId: null,
      issuedAt,
      expiresAt,
    });
    await database.db.delete(authUsers).where(eq(authUsers.id, userId));
    expect(
      await repository.read((reader) => reader.getRoomCreationOperation(userId)),
    ).toBeUndefined();
  });
});
