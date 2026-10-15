import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { user, verification } from "./schema/auth.js";
import { games } from "./schema/games.js";
import {
  type AbortSharedGame,
  deleteAccountRooms,
  removeRoomHistory,
} from "./shared-history-repository.js";

type Executor = Pick<
  DatabaseConnection["db"],
  "select" | "insert" | "update" | "delete" | "execute"
>;

// Both callers hold the shared-room gate and account lock; public deletion also supplies its session recheck.
export async function removeAccountData<T>(
  db: Executor,
  userId: string,
  abort: AbortSharedGame,
  beforeIdentityRemoval: () => Promise<T>,
): Promise<T> {
  await deleteAccountRooms(db, userId, abort);
  await db
    .delete(games)
    .where(
      and(eq(games.ownerUserId, userId), or(isNull(games.mode), ne(games.mode, "human_vs_human"))),
    );
  await db.delete(verification).where(eq(verification.value, userId));
  const proof = await beforeIdentityRemoval();
  await db.delete(user).where(eq(user.id, userId));
  return proof;
}

export async function removeAccountHistory(db: Executor, userId: string, gameId?: string) {
  await removeRoomHistory(db, userId, gameId);
  await db
    .delete(games)
    .where(
      and(
        eq(games.ownerUserId, userId),
        eq(games.isSandbox, false),
        inArray(games.mode, ["ai_vs_ai", "ai_vs_human"]),
        inArray(games.state, ["completed", "aborted"]),
        gameId === undefined ? undefined : eq(games.id, gameId),
      ),
    );
}
