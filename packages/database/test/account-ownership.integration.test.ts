import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  authUsers,
  createGameRepository,
  gameParticipants,
  games,
  guestSessions,
} from "../src/index.js";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function fixture() {
  const database = integrationDatabase();
  const userId = randomUUID();
  const guest = await createGameRepository(database).createGuest(
    createHash("sha256").update(randomUUID()).digest("hex"),
    3600,
  );
  await database.db
    .insert(authUsers)
    .values({ id: userId, name: "", email: `${userId}@example.com`, emailVerified: true });
  disposers.push(async () => {
    try {
      await database.db.delete(games).where(eq(games.ownerUserId, userId));
      await database.db.delete(games).where(eq(games.ownerGuestSessionId, guest.id));
      await database.db.delete(authUsers).where(eq(authUsers.id, userId));
      await database.db.delete(guestSessions).where(eq(guestSessions.id, guest.id));
    } finally {
      await database.close();
    }
  });
  const position = {
    state: "active" as const,
    result: "*" as const,
    fen: "structural-position-fixture",
    pgn: "structural-history-fixture",
  };
  return { database, userId, guestId: guest.id, position };
}

describe("relational account game constraints", () => {
  it("requires exactly one existing owner and permits only guests to own Sandbox", async () => {
    const { database, userId, guestId, position } = await fixture();
    for (const owners of [
      {},
      { ownerUserId: userId, ownerGuestSessionId: guestId },
      { ownerUserId: randomUUID() },
      { ownerUserId: userId, isSandbox: true },
    ]) {
      await expect(database.db.insert(games).values({ ...position, ...owners })).rejects.toThrow();
    }
    const [accountGame] = await database.db
      .insert(games)
      .values({ ...position, ownerUserId: userId })
      .returning();
    expect(accountGame).toMatchObject({
      ownerUserId: userId,
      ownerGuestSessionId: null,
      isSandbox: false,
    });
    await expect(database.db.delete(authUsers).where(eq(authUsers.id, userId))).rejects.toThrow();
  });

  it("enforces the account limit without relying on application locks and releases only terminal slots", async () => {
    const { database, userId, guestId, position } = await fixture();
    const results = await Promise.allSettled(
      ["ai_vs_ai", "ai_vs_human"].map((mode) =>
        database.db
          .insert(games)
          .values({ ...position, ownerUserId: userId, mode: mode as "ai_vs_ai" | "ai_vs_human" })
          .returning(),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await database.db.update(games).set({ state: "paused" }).where(eq(games.ownerUserId, userId));
    await expect(
      database.db.insert(games).values({ ...position, ownerUserId: userId }),
    ).rejects.toThrow();
    await database.db.insert(games).values([
      { ...position, ownerGuestSessionId: guestId },
      { ...position, ownerGuestSessionId: guestId, isSandbox: true },
    ]);
    await database.db
      .update(games)
      .set({ state: "aborted", terminationReason: "aborted" })
      .where(eq(games.ownerUserId, userId));
    await database.db.insert(games).values({ ...position, ownerUserId: userId });
    expect(await database.db.$count(games, eq(games.ownerUserId, userId))).toBe(2);
    expect(await database.db.$count(games, eq(games.ownerGuestSessionId, guestId))).toBe(2);
  });

  it("rejects dual identities, nonexistent users and human authority on AI seats", async () => {
    const { database, userId, guestId, position } = await fixture();
    const [game] = await database.db
      .insert(games)
      .values({ ...position, ownerUserId: userId })
      .returning();
    const seat = { gameId: game!.id, color: "white" as const, seatType: "human" as const };
    await expect(
      database.db.insert(gameParticipants).values({ ...seat, userId, guestSessionId: guestId }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({ ...seat, userId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({
        ...seat,
        seatType: "ai",
        userId,
        provider: "openai",
        modelId: "fixture",
        parameters: {},
      }),
    ).rejects.toThrow();
    await database.db.insert(gameParticipants).values({ ...seat, userId });
    await expect(
      database.db.insert(gameParticipants).values({ ...seat, color: "black", userId }),
    ).rejects.toThrow();
    await database.db.insert(gameParticipants).values({
      ...seat,
      color: "black",
      seatType: "ai",
      provider: "openai",
      modelId: "fixture",
      parameters: {},
    });
  });
});
