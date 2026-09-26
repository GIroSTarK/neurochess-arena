import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { gameParticipants, games, profiles } from "./schema/index.js";

export interface HistoryBoundary {
  readonly finishedAt: string;
  readonly gameId: string;
}

export type StoredHistoryGame = Pick<
  typeof games.$inferSelect,
  | "id"
  | "mode"
  | "state"
  | "result"
  | "terminationReason"
  | "ownerUserId"
  | "ownerGuestSessionId"
  | "isSandbox"
> & {
  finishedAt: string;
  username: string | null;
  participants: (typeof gameParticipants.$inferSelect)[];
};

function terminalHistoryScope(userId: string) {
  return and(
    eq(games.ownerUserId, userId),
    eq(games.isSandbox, false),
    inArray(games.mode, ["ai_vs_ai", "ai_vs_human"]),
    inArray(games.state, ["completed", "aborted"]),
  );
}

// Caller holds the account lock, which serializes creation, completion and deletion.
export async function deleteAccountHistory(
  db: Pick<DatabaseConnection["db"], "delete">,
  userId: string,
  gameId?: string,
): Promise<void> {
  await db
    .delete(games)
    .where(
      and(terminalHistoryScope(userId), gameId === undefined ? undefined : eq(games.id, gameId)),
    );
}

export async function readAccountHistory(
  db: Pick<DatabaseConnection["db"], "select">,
  userId: string,
  limit: number,
  cursor?: HistoryBoundary,
): Promise<StoredHistoryGame[]> {
  const rows = await db
    .select({
      id: games.id,
      mode: games.mode,
      state: games.state,
      result: games.result,
      terminationReason: games.terminationReason,
      ownerUserId: games.ownerUserId,
      ownerGuestSessionId: games.ownerGuestSessionId,
      isSandbox: games.isSandbox,
      username: profiles.username,
      // Keep database microseconds: a JavaScript Date would truncate the pagination boundary.
      finishedAt: sql<string>`to_char(${games.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(games)
    .leftJoin(profiles, eq(profiles.userId, games.ownerUserId))
    .where(
      and(
        terminalHistoryScope(userId),
        cursor
          ? sql`(${games.updatedAt}, ${games.id}) < (${cursor.finishedAt}::timestamptz, ${cursor.gameId}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(games.updatedAt), desc(games.id))
    .limit(limit + 1);
  if (rows.length === 0) return [];
  const participants = await db
    .select()
    .from(gameParticipants)
    .where(
      inArray(
        gameParticipants.gameId,
        rows.map((row) => row.id),
      ),
    );
  return rows.map((row) => ({
    ...row,
    participants: participants.filter((seat) => seat.gameId === row.id),
  }));
}
