import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { authUsers, profiles } from "../src/index.js";

const database = integrationDatabase();
const userIds: string[] = [];
afterEach(async () => {
  if (userIds.length) {
    await database.db.delete(authUsers).where(inArray(authUsers.id, userIds.splice(0)));
  }
});
afterAll(() => database.close());

async function user() {
  const id = randomUUID();
  userIds.push(id);
  await database.db.insert(authUsers).values({ id, name: "", email: `${id}@example.com` });
  return id;
}

describe("PostgreSQL profile invariants", () => {
  it("enforces username syntax, lowercase correspondence and reserved names for direct writes", async () => {
    const userId = await user();
    for (const [username, usernameNormalized] of [
      ["ab", "ab"],
      ["x".repeat(25), "x".repeat(25)],
      ["élan", "élan"],
      ["A b", "a b"],
      [" Valid ", " valid "],
      ["Valid", "VALID"],
      ["Valid", "other"],
      ["Valid", null],
      [null, "valid"],
      ...[
        "admin",
        "administrator",
        "api",
        "arena",
        "auth",
        "guest",
        "help",
        "login",
        "logout",
        "moderator",
        "neurochess",
        "root",
        "security",
        "support",
        "system",
        "www",
      ].map((name) => [name.toUpperCase(), name]),
    ]) {
      await expect(
        database.db.insert(profiles).values({
          userId,
          username: username ?? null,
          usernameNormalized: usernameNormalized ?? null,
        }),
      ).rejects.toThrow();
    }
    await database.db
      .insert(profiles)
      .values({ userId, username: "Ab_", usernameNormalized: "ab_" });
    await database.db
      .update(profiles)
      .set({ username: "I".repeat(24), usernameNormalized: "i".repeat(24) })
      .where(eq(profiles.userId, userId));
  });

  it("enforces uniqueness independently of the API and cascades only the deleted user's profile", async () => {
    const first = await user();
    const second = await user();
    const username = `Db_${randomUUID().slice(0, 8)}`;
    await database.db
      .insert(profiles)
      .values({ userId: first, username, usernameNormalized: username.toLowerCase() });
    await expect(
      database.db.insert(profiles).values({
        userId: second,
        username: username.toUpperCase(),
        usernameNormalized: username.toLowerCase(),
      }),
    ).rejects.toThrow();
    await expect(database.db.insert(profiles).values({ userId: randomUUID() })).rejects.toThrow();
    await database.db.insert(profiles).values({ userId: second, avatarRemoved: true });
    await database.db.delete(authUsers).where(eq(authUsers.id, first));
    expect(await database.db.$count(profiles, eq(profiles.userId, first))).toBe(0);
    expect(await database.db.$count(profiles, eq(profiles.userId, second))).toBe(1);
  });
});
