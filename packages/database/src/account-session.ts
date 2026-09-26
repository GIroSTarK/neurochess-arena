import { and, eq, gt, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { session, user } from "./schema/auth.js";

type Reader = Pick<DatabaseConnection["db"], "select">;

export async function hasAccountSession(
  db: Reader,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  // Better Auth stores UTC in timestamp-without-time-zone columns.
  const [active] = await db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, userId),
        gt(session.expiresAt, sql`(clock_timestamp() at time zone 'UTC')`),
      ),
    );
  return active !== undefined;
}

export async function lockAccountSession(
  db: Reader,
  userId: string,
  sessionId: string,
  mode: "update" | "share" = "update",
): Promise<boolean> {
  // Keep user-before-session ordering across account commands; fence revocation.
  await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).for(mode);
  await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
    .for("share");
  return hasAccountSession(db, userId, sessionId);
}
