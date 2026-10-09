import { and, asc, eq, inArray, isNotNull, notExists, or, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import type { GamePositionUpdate, StoredGame, StoredMove } from "./game-records.js";
import { gameSlots } from "./schema/game-slots.js";
import { gameParticipants, games, guestSessions, moves } from "./schema/games.js";
import { rooms } from "./schema/rooms.js";
import { roomHistoryAccess } from "./schema/shared-history.js";

type Executor = Pick<
  DatabaseConnection["db"],
  "select" | "insert" | "update" | "delete" | "execute"
>;
export type AbortSharedGame = (game: StoredGame, moves: StoredMove[]) => GamePositionUpdate;

// Every shared writer enters this gate before taking any identity or game write lock.
export async function lockSharedRooms(db: Pick<Executor, "execute">): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(1848788328, 4)`);
}

export function retainedRoomAccess(db: Pick<Executor, "select">, userId?: string) {
  return db
    .select({ gameId: roomHistoryAccess.gameId })
    .from(roomHistoryAccess)
    .where(
      and(
        eq(roomHistoryAccess.gameId, games.id),
        userId === undefined ? undefined : eq(roomHistoryAccess.userId, userId),
      ),
    );
}

function guestBindings(db: Pick<Executor, "select">) {
  return db
    .select({ id: gameParticipants.id })
    .from(gameParticipants)
    .where(and(eq(gameParticipants.gameId, games.id), isNotNull(gameParticipants.guestSessionId)));
}

async function purgeUnretainedAccountRooms(db: Executor, gameId: string) {
  await db
    .delete(games)
    .where(
      and(
        eq(games.id, gameId),
        eq(games.mode, "human_vs_human"),
        inArray(games.state, ["completed", "aborted"]),
        notExists(retainedRoomAccess(db)),
        notExists(guestBindings(db)),
      ),
    );
}

export async function removeRoomHistory(db: Executor, userId: string, gameId?: string) {
  const records = await db
    .select({ id: games.id })
    .from(games)
    .where(
      and(
        eq(games.mode, "human_vs_human"),
        inArray(games.state, ["completed", "aborted"]),
        inArray(
          games.id,
          db
            .select({ gameId: roomHistoryAccess.gameId })
            .from(roomHistoryAccess)
            .where(eq(roomHistoryAccess.userId, userId)),
        ),
        gameId === undefined ? undefined : eq(games.id, gameId),
      ),
    )
    .orderBy(asc(games.id))
    .for("update");
  for (const game of records) {
    await db
      .delete(roomHistoryAccess)
      .where(and(eq(roomHistoryAccess.gameId, game.id), eq(roomHistoryAccess.userId, userId)));
    await purgeUnretainedAccountRooms(db, game.id);
  }
}

export async function deleteAccountRooms(db: Executor, userId: string, abort: AbortSharedGame) {
  const records = await db
    .select()
    .from(games)
    .where(
      and(
        eq(games.mode, "human_vs_human"),
        or(
          eq(games.ownerUserId, userId),
          inArray(
            games.id,
            db
              .select({ gameId: gameParticipants.gameId })
              .from(gameParticipants)
              .where(eq(gameParticipants.userId, userId)),
          ),
          inArray(
            games.id,
            db
              .select({ gameId: roomHistoryAccess.gameId })
              .from(roomHistoryAccess)
              .where(eq(roomHistoryAccess.userId, userId)),
          ),
        ),
      ),
    )
    .orderBy(asc(games.id))
    .for("update");
  for (const game of records) {
    if (game.state === "active" || game.state === "paused") {
      const history = await db
        .select()
        .from(moves)
        .where(eq(moves.gameId, game.id))
        .orderBy(asc(moves.ply));
      await db
        .update(games)
        .set({ ...abort(game, history), updatedAt: sql`clock_timestamp()` })
        .where(eq(games.id, game.id));
      await db.delete(gameSlots).where(eq(gameSlots.gameId, game.id));
    }
    await db.update(rooms).set({ invitationDigest: null }).where(eq(rooms.gameId, game.id));
    await db
      .update(gameParticipants)
      .set({ userId: null })
      .where(and(eq(gameParticipants.gameId, game.id), eq(gameParticipants.userId, userId)));
    // Anonymization must not change the immutable terminal history ordering.
    if (game.ownerUserId === userId) {
      await db.update(games).set({ ownerUserId: null }).where(eq(games.id, game.id));
    }
    await db
      .delete(roomHistoryAccess)
      .where(and(eq(roomHistoryAccess.gameId, game.id), eq(roomHistoryAccess.userId, userId)));
    await purgeUnretainedAccountRooms(db, game.id);
  }
}

export async function cleanupSharedRooms(connection: DatabaseConnection): Promise<void> {
  const db = connection.db;
  // An unlocked scan selects work only. Eligibility is rechecked after renewal's row lock.
  const candidates = await db
    .selectDistinct({ guestId: guestSessions.id })
    .from(guestSessions)
    .innerJoin(gameParticipants, eq(gameParticipants.guestSessionId, guestSessions.id))
    .innerJoin(games, eq(games.id, gameParticipants.gameId))
    .where(
      and(
        eq(games.mode, "human_vs_human"),
        inArray(games.state, ["completed", "aborted"]),
        notExists(retainedRoomAccess(db)),
        sql`${guestSessions.expiresAt} <= clock_timestamp()`,
      ),
    )
    .orderBy(asc(guestSessions.id))
    .limit(100);
  for (const { guestId } of candidates) {
    await db.transaction(async (tx) => {
      await lockSharedRooms(tx);
      const [guest] = await tx
        .select({ id: guestSessions.id })
        .from(guestSessions)
        .where(eq(guestSessions.id, guestId))
        .for("update");
      if (!guest) return;
      const [expired] = await tx
        .select({ id: guestSessions.id })
        .from(guestSessions)
        .where(
          and(eq(guestSessions.id, guestId), sql`${guestSessions.expiresAt} <= clock_timestamp()`),
        );
      if (!expired) return;
      const records = await tx
        .select({ id: games.id })
        .from(games)
        .where(
          and(
            eq(games.mode, "human_vs_human"),
            inArray(games.state, ["completed", "aborted"]),
            notExists(retainedRoomAccess(tx)),
            inArray(
              games.id,
              tx
                .select({ gameId: gameParticipants.gameId })
                .from(gameParticipants)
                .where(eq(gameParticipants.guestSessionId, guestId)),
            ),
          ),
        )
        .orderBy(asc(games.id))
        .for("update");
      for (const game of records) await tx.delete(games).where(eq(games.id, game.id));
    });
  }
}
