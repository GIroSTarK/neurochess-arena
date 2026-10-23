import { and, eq, gt, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { session, user } from "./schema/auth.js";
import { guestSessions } from "./schema/games.js";
import { profiles } from "./schema/profiles.js";

export type StoredGuestSession = typeof guestSessions.$inferSelect;

export interface IdentityReader {
  getGuest(id: string): Promise<StoredGuestSession | undefined>;
  hasAccountSession(userId: string, sessionId: string): Promise<boolean>;
  getAccountUsername(userId: string): Promise<string | null>;
}

export interface IdentityTransaction extends IdentityReader {
  lockGuest(id: string): Promise<StoredGuestSession | undefined>;
  lockAccount(id: string): Promise<void>;
}

type Executor = Pick<DatabaseConnection["db"], "select">;

export function identityReaderFor(db: Executor): IdentityReader {
  return {
    async getGuest(id) {
      const [guest] = await db
        .select()
        .from(guestSessions)
        .where(and(eq(guestSessions.id, id), gt(guestSessions.expiresAt, sql`clock_timestamp()`)));
      return guest;
    },
    async hasAccountSession(userId, sessionId) {
      const [active] = await db
        .select({ id: session.id })
        .from(session)
        .where(
          and(
            eq(session.id, sessionId),
            eq(session.userId, userId),
            // Better Auth stores UTC in timestamp-without-time-zone columns.
            gt(session.expiresAt, sql`clock_timestamp() at time zone 'UTC'`),
          ),
        );
      return active !== undefined;
    },
    async getAccountUsername(userId) {
      const [profile] = await db
        .select({ username: profiles.username })
        .from(profiles)
        .where(eq(profiles.userId, userId));
      return profile?.username ?? null;
    },
  };
}

export function identityTransactionFor(tx: Executor): IdentityTransaction {
  const reader = identityReaderFor(tx);
  return {
    ...reader,
    async lockGuest(id) {
      await tx
        .select({ id: guestSessions.id })
        .from(guestSessions)
        .where(eq(guestSessions.id, id))
        .for("update");
      // Check expiry after any lock wait, using the database clock.
      return reader.getGuest(id);
    },
    async lockAccount(id) {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, id)).for("update");
    },
  };
}
