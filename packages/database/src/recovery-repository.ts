import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { removeAccountData, removeAccountHistory } from "./account-removal.js";
import type { DatabaseConnection } from "./client.js";
import { session, user, verification } from "./schema/auth.js";
import { providerCredentials } from "./schema/credentials.js";
import { games, guestSessions } from "./schema/games.js";
import { rooms } from "./schema/rooms.js";
import {
  type AbortSharedGame,
  cleanupSharedRooms,
  lockSharedRooms,
} from "./shared-history-repository.js";

const manifestSchema = z.strictObject({
  confirm: z.literal("reconcile-isolated-restore-v1"),
  accounts: z.array(z.uuid()).max(10000),
  history: z.array(z.strictObject({ userId: z.uuid(), gameId: z.uuid() })).max(10000),
  credentials: z.array(z.strictObject({ userId: z.uuid(), credentialId: z.uuid() })).max(10000),
  guests: z.array(z.uuid()).max(10000).default([]),
  invitations: z.array(z.uuid()).max(10000).default([]),
  invalidateSessions: z.literal(true),
});

export async function reconcileRestoredDatabase(
  database: DatabaseConnection,
  input: unknown,
  abort: AbortSharedGame,
): Promise<void> {
  const manifest = manifestSchema.parse(input);
  await database.db.transaction(async (tx) => {
    const guard = await tx.execute<{ name: string; others: number }>(sql`
      select current_database() as name, (select count(*)::int from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend') as others
    `);
    if (
      !/^nc_restore_[a-f0-9]{32}$/.test(guard.rows[0]?.name ?? "") ||
      guard.rows[0]?.others !== 0
    ) {
      throw new Error("RESTORE_RECONCILIATION_REFUSED");
    }
    await lockSharedRooms(tx);
    const userIds = [
      ...new Set([
        ...manifest.accounts,
        ...manifest.history.map((x) => x.userId),
        ...manifest.credentials.map((x) => x.userId),
      ]),
    ];
    if (userIds.length) {
      await tx
        .select({ id: user.id })
        .from(user)
        .where(inArray(user.id, userIds))
        .orderBy(asc(user.id))
        .for("update");
    }
    for (const userId of manifest.accounts) {
      await removeAccountData(tx, userId, abort, async () => undefined);
    }
    for (const entry of manifest.history) {
      if (entry.gameId) {
        const [game] = await tx
          .select({ state: games.state })
          .from(games)
          .where(eq(games.id, entry.gameId));
        if (game && !["completed", "aborted"].includes(game.state)) {
          throw new Error("RESTORE_HISTORY_UNFINISHED");
        }
      }
      await removeAccountHistory(tx, entry.userId, entry.gameId);
    }
    for (const entry of manifest.credentials) {
      await tx
        .delete(providerCredentials)
        .where(
          and(
            eq(providerCredentials.userId, entry.userId),
            eq(providerCredentials.id, entry.credentialId),
          ),
        );
    }
    if (manifest.guests.length) {
      await tx
        .update(guestSessions)
        .set({
          lastSeenAt: sql`least(last_seen_at, clock_timestamp() - interval '1 second')`,
          expiresAt: sql`clock_timestamp()`,
        })
        .where(inArray(guestSessions.id, manifest.guests));
    }
    if (manifest.invitations.length) {
      const revoked = await tx
        .update(rooms)
        .set({ invitationDigest: null })
        .where(and(inArray(rooms.gameId, manifest.invitations), isNotNull(rooms.invitationDigest)))
        .returning({ gameId: rooms.gameId });
      if (revoked.length) {
        await tx
          .update(games)
          .set({ version: sql`${games.version} + 1` })
          .where(
            inArray(
              games.id,
              revoked.map((room) => room.gameId),
            ),
          );
      }
    }
    await tx.delete(session);
    await tx.delete(verification);
  });
  await cleanupSharedRooms(database);
}
