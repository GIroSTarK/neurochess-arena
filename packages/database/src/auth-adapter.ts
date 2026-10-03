import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { and, eq, gt, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import * as schema from "./schema/auth.js";
import { games } from "./schema/index.js";

export class AuthAccountUnavailableError extends Error {}
export class AccountDeletionSessionError extends Error {
  constructor(readonly code: "AUTH_UNAUTHORIZED" | "AUTH_REAUTH_REQUIRED") {
    super(code);
  }
}

export interface AuthAccountActions {
  deleteAccount(sessionId: string, freshAgeSeconds: number): Promise<void>;
}

export function createAuthDatabaseAdapter(database: DatabaseConnection) {
  return drizzleAdapter(database.db, { provider: "pg", schema, transaction: true });
}

export async function withAuthUserLock<T>(
  database: DatabaseConnection,
  userId: string,
  operation: (
    adapter: ReturnType<typeof createAuthDatabaseAdapter>,
    actions: AuthAccountActions,
  ) => Promise<T>,
): Promise<T> {
  return database.db.transaction(async (transaction) => {
    const [user] = await transaction
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .for("update");
    if (!user) throw new AuthAccountUnavailableError("Authentication account is unavailable");
    // Password verification/session creation and reset/revocation must share
    // both this account lock and connection, including nested adapter work.
    return operation(drizzleAdapter(transaction, { provider: "pg", schema, transaction: true }), {
      async deleteAccount(sessionId, freshAgeSeconds) {
        // Keep authentication rejection counts in the outer transaction while
        // rolling back every application/auth deletion on a late identity failure.
        await transaction.transaction(async (deletion) => {
          const requireSession = async () => {
            const [session] = await deletion
              .select({
                expiresAt: schema.session.expiresAt,
                createdAt: schema.session.createdAt,
                fresh: sql<boolean>`${schema.session.createdAt} > (clock_timestamp() at time zone 'UTC') - ${freshAgeSeconds} * interval '1 second'`,
              })
              .from(schema.session)
              .where(
                and(
                  eq(schema.session.id, sessionId),
                  eq(schema.session.userId, userId),
                  gt(schema.session.expiresAt, sql`clock_timestamp() at time zone 'UTC'`),
                ),
              );
            if (!session) throw new AccountDeletionSessionError("AUTH_UNAUTHORIZED");
            if (!session.fresh) throw new AccountDeletionSessionError("AUTH_REAUTH_REQUIRED");
            return session;
          };
          await requireSession();
          await deletion.delete(games).where(eq(games.ownerUserId, userId));
          // Recovery records have no user foreign key. OAuth state is unassociated
          // until callback, and email verification uses account-bound signed tokens.
          await deletion.delete(schema.verification).where(eq(schema.verification.value, userId));
          // Cascades may wait on other writers; expiry must roll back all removals.
          const proof = await requireSession();
          await deletion.delete(schema.user).where(eq(schema.user.id, userId));
          // User cascades can wait too. The session is now deleted, so check its
          // last authoritative deadlines before permitting this transaction to commit.
          const deadline = new Date(proof.createdAt.getTime() + freshAgeSeconds * 1000);
          const result = await deletion.execute<{ active: boolean; fresh: boolean }>(sql`
          select (clock_timestamp() at time zone 'UTC') < ${proof.expiresAt.toISOString()}::timestamp as active,
                 (clock_timestamp() at time zone 'UTC') < ${deadline.toISOString()}::timestamp as fresh
        `);
          if (!result.rows[0]?.active) throw new AccountDeletionSessionError("AUTH_UNAUTHORIZED");
          if (!result.rows[0].fresh) throw new AccountDeletionSessionError("AUTH_REAUTH_REQUIRED");
        });
      },
    });
  });
}
