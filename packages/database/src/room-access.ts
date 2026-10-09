import { and, eq, exists, gt, inArray, isNotNull, or, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { session, user } from "./schema/auth.js";
import { gameParticipants, games, guestSessions } from "./schema/games.js";
import { profiles } from "./schema/profiles.js";
import { rooms } from "./schema/rooms.js";
import { roomHistoryAccess } from "./schema/shared-history.js";

export type RoomAccessIdentity =
  { readonly userId: string; readonly sessionId: string } | { readonly guestSessionId: string };

// One statement on the pool, outside a previously opened read snapshot, is the
// authorization boundary for delivery. Separate predicate queries can disagree
// with a session/access removal committed between them.
export async function hasCurrentRoomAccess(
  { db }: DatabaseConnection,
  gameId: string,
  identity: RoomAccessIdentity,
): Promise<boolean> {
  const authority =
    "userId" in identity
      ? and(
          eq(gameParticipants.userId, identity.userId),
          exists(
            db
              .select({ id: session.id })
              .from(session)
              .innerJoin(user, eq(user.id, session.userId))
              .innerJoin(profiles, eq(profiles.userId, user.id))
              .where(
                and(
                  eq(session.id, identity.sessionId),
                  eq(session.userId, identity.userId),
                  gt(session.expiresAt, sql`clock_timestamp() at time zone 'UTC'`),
                  eq(user.emailVerified, true),
                  isNotNull(profiles.username),
                ),
              ),
          ),
          or(
            inArray(games.state, ["active", "paused"]),
            exists(
              db
                .select({ id: roomHistoryAccess.gameId })
                .from(roomHistoryAccess)
                .where(
                  and(
                    eq(roomHistoryAccess.gameId, games.id),
                    eq(roomHistoryAccess.userId, identity.userId),
                  ),
                ),
            ),
          ),
        )
      : and(
          eq(gameParticipants.guestSessionId, identity.guestSessionId),
          exists(
            db
              .select({ id: guestSessions.id })
              .from(guestSessions)
              .where(
                and(
                  eq(guestSessions.id, identity.guestSessionId),
                  gt(guestSessions.expiresAt, sql`clock_timestamp()`),
                ),
              ),
          ),
        );
  const [allowed] = await db
    .select({ id: games.id })
    .from(games)
    .innerJoin(rooms, eq(rooms.gameId, games.id))
    .innerJoin(gameParticipants, eq(gameParticipants.gameId, games.id))
    .where(
      and(
        eq(games.id, gameId),
        eq(games.mode, "human_vs_human"),
        eq(games.isSandbox, false),
        authority,
      ),
    )
    .limit(1);
  return allowed !== undefined;
}
