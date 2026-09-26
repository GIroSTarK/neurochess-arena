import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { lockAccountSession } from "./account-session.js";
import type { DatabaseConnection } from "./client.js";
import { accountDeletionMarkers } from "./schema/account-deletion.js";
import { account, session, user } from "./schema/auth.js";
import { games } from "./schema/index.js";

export type AccountDeletionResult = "deleted" | "unauthorized" | "reauthentication_required";
class DeletionRejected extends Error {
  constructor(readonly result: Exclude<AccountDeletionResult, "deleted">) {
    super(result);
  }
}

export function createAccountRepository(database: DatabaseConnection) {
  return {
    async oauthStartedAt(): Promise<string> {
      const result = await database.db.execute<{ time: string }>(
        sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as time`,
      );
      const timestamp = result.rows[0]?.time;
      if (!timestamp) throw new Error("ACCOUNT_CLOCK_UNAVAILABLE");
      return timestamp;
    },
    async allowsOAuth(identifiers: readonly string[], startedAt: string): Promise<boolean> {
      const result = await database.db.execute<{ allowed: boolean }>(sql`select (
        ${startedAt}::timestamptz > clock_timestamp() - interval '10 minutes'
        and ${startedAt}::timestamptz <= clock_timestamp()
        and not exists (select 1 from ${accountDeletionMarkers}
          where ${inArray(accountDeletionMarkers.fingerprint, [...identifiers])}
            and ${accountDeletionMarkers.cutoff} >= ${startedAt}::timestamptz
            and ${accountDeletionMarkers.expiresAt} > clock_timestamp())
      ) as allowed`);
      return result.rows[0]?.allowed === true;
    },
    async cleanupDeletionMarkers(): Promise<void> {
      await database.db
        .delete(accountDeletionMarkers)
        .where(lte(accountDeletionMarkers.expiresAt, sql`clock_timestamp()`));
    },
    async verifyEmail(userId: string, email: string): Promise<boolean> {
      // Target the immutable ID in the write itself, even if deletion/re-registration races verification.
      const verified = await database.db
        .update(user)
        .set({ emailVerified: true })
        .where(and(eq(user.id, userId), eq(user.email, email)))
        .returning({ id: user.id });
      return verified.length === 1;
    },
    async delete(
      userId: string,
      sessionId: string,
      freshAgeSeconds: number,
      fingerprint: (provider: string, subject: string) => string,
    ): Promise<AccountDeletionResult> {
      try {
        return await database.db.transaction(async (tx) => {
          if (!(await lockAccountSession(tx, userId, sessionId))) return "unauthorized";
          // The session share lock prevents revocation/updates. Preserve exact timestamps for
          // the final clock check after its own row has been removed by the user cascade.
          const [lockedSession] = await tx
            .select({
              expiresAt: sql<string>`${session.expiresAt}::text`,
              createdAt: sql<string>`${session.createdAt}::text`,
            })
            .from(session)
            .where(and(eq(session.id, sessionId), eq(session.userId, userId)));
          if (!lockedSession) return "unauthorized";
          const recheck = async () => {
            const checked = await tx.execute<{ active: boolean; fresh: boolean }>(sql`select
              ${lockedSession.expiresAt}::timestamp > (clock_timestamp() at time zone 'UTC') as active,
              ${lockedSession.createdAt}::timestamp > (clock_timestamp() at time zone 'UTC') - ${freshAgeSeconds} * interval '1 second' as fresh`);
            if (!checked.rows[0]?.active) throw new DeletionRejected("unauthorized");
            if (!checked.rows[0].fresh) throw new DeletionRejected("reauthentication_required");
          };
          await recheck();
          // The user lock fences creation, renewals, dispatch/retry and late outcomes across API instances.
          await tx
            .delete(games)
            .where(
              and(
                eq(games.ownerUserId, userId),
                eq(games.isSandbox, false),
                inArray(games.mode, ["ai_vs_ai", "ai_vs_human"]),
              ),
            );
          // Cascades may wait; expiry or lost freshness must roll back application cleanup too.
          await recheck();
          const [owner] = await tx
            .select({ email: user.email })
            .from(user)
            .where(eq(user.id, userId));
          if (!owner) throw new DeletionRejected("unauthorized");
          const bindings = await tx
            .select({ provider: account.providerId, subject: account.accountId })
            .from(account)
            .where(eq(account.userId, userId));
          const markers = new Set([
            fingerprint("email", owner.email.toLowerCase()),
            ...bindings
              .filter((binding) => binding.provider === "google" || binding.provider === "github")
              .map((binding) => fingerprint(binding.provider, binding.subject)),
          ]);
          // Restricting game/seat FKs deliberately reject future shared-human data until retention is defined.
          await tx.delete(user).where(eq(user.id, userId));
          // Record the cutoff after cascade waits. This fence survives deletion and API restarts.
          await tx
            .insert(accountDeletionMarkers)
            .values(
              [...markers].map((fingerprint) => ({
                fingerprint,
                cutoff: sql`clock_timestamp()`,
                expiresAt: sql`clock_timestamp() + interval '10 minutes'`,
              })),
            )
            .onConflictDoUpdate({
              target: accountDeletionMarkers.fingerprint,
              set: {
                cutoff: sql`clock_timestamp()`,
                expiresAt: sql`clock_timestamp() + interval '10 minutes'`,
              },
            });
          await recheck();
          return "deleted";
        });
      } catch (error) {
        if (error instanceof DeletionRejected) return error.result;
        throw error;
      }
    },
  };
}
