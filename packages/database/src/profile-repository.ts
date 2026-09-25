import { eq, sql } from "drizzle-orm";

import { hasAccountSession, lockAccountSession } from "./account-session.js";
import type { DatabaseConnection } from "./client.js";
import { account, user } from "./schema/auth.js";
import { profiles } from "./schema/profiles.js";

export interface StoredProfileState {
  readonly profile: typeof profiles.$inferSelect | undefined;
  readonly image: string | null;
  readonly providers: readonly string[];
}
type ProfileChange = Pick<
  typeof profiles.$inferInsert,
  "username" | "usernameNormalized" | "avatarPreference"
>;
export interface ProfileRepository {
  read(userId: string, sessionId: string): Promise<StoredProfileState | undefined>;
  update(
    userId: string,
    sessionId: string,
    change: (current: StoredProfileState) => ProfileChange,
  ): Promise<StoredProfileState | undefined>;
}

class ExpiredProfileSession extends Error {}

export function createProfileRepository(database: DatabaseConnection): ProfileRepository {
  const operate = async (
    userId: string,
    sessionId: string,
    change?: (current: StoredProfileState) => ProfileChange,
  ) => {
    try {
      return await database.db.transaction(async (tx) => {
        if (!(await lockAccountSession(tx, userId, sessionId, change ? "update" : "share"))) {
          return undefined;
        }
        const [owner] = await tx
          .select({ image: user.image })
          .from(user)
          .where(eq(user.id, userId));
        if (!owner) return undefined;
        const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
        const bindings = await tx
          .select({ provider: account.providerId })
          .from(account)
          .where(eq(account.userId, userId));
        const current = {
          profile,
          image: owner.image,
          providers: bindings.map((entry) => entry.provider),
        };
        if (!change) return current;
        const patch = change(current);
        const [saved] = await tx
          .insert(profiles)
          .values({ userId, ...patch })
          .onConflictDoUpdate({
            target: profiles.userId,
            set: { ...patch, updatedAt: sql`clock_timestamp()` },
          })
          .returning();
        // A competing username claim can wait on another account's unique-index transaction.
        if (!(await hasAccountSession(tx, userId, sessionId))) throw new ExpiredProfileSession();
        return { ...current, profile: saved };
      });
    } catch (error) {
      if (error instanceof ExpiredProfileSession) return undefined;
      throw error;
    }
  };
  return { read: (userId, sessionId) => operate(userId, sessionId), update: operate };
}
