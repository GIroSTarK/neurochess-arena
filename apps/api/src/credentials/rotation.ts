import { type DatabaseConnection, providerCredentials } from "@neurochess/database";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { credentialEncryptionKeySchema, credentialKeyIdSchema } from "./configuration.js";
import { createCredentialCipher } from "./crypto.js";

const keySchema = z.strictObject({
  keyId: credentialKeyIdSchema,
  key: credentialEncryptionKeySchema,
});
const manifestSchema = z
  .strictObject({
    confirm: z.literal("rotate-provider-credentials-v1"),
    old: keySchema,
    next: keySchema,
  })
  .refine((value) => value.old.keyId !== value.next.keyId && value.old.key !== value.next.key);
const modeSchema = z.enum(["verify-old", "rotate", "verify-new", "rollback"]);
type Row = typeof providerCredentials.$inferSelect;

function context(row: Row) {
  return { userId: row.userId, credentialId: row.id, provider: row.provider };
}

function envelope(row: Row) {
  return {
    version: row.version,
    keyId: row.keyId,
    nonce: row.nonce,
    authTag: row.authTag,
    ciphertext: row.ciphertext,
  };
}

export async function maintainCredentials(
  database: DatabaseConnection,
  input: unknown,
  modeInput: unknown,
): Promise<number> {
  try {
    const manifest = manifestSchema.parse(input);
    const mode = modeSchema.parse(modeInput);
    const old = createCredentialCipher(manifest.old);
    const next = createCredentialCipher(manifest.next);
    const source = mode === "verify-new" || mode === "rollback" ? next : old;
    const target = mode === "rollback" ? old : next;
    const write = mode === "rotate" || mode === "rollback";
    return await database.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '30s'`);
      await tx.execute(sql`set local idle_in_transaction_session_timeout = '30s'`);
      const guard = await tx.execute<{ others: number }>(sql`
        select count(*)::int as others from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and backend_type = 'client backend'
      `);
      if (guard.rows[0]?.others !== 0) throw new Error();
      // The guard detects existing clients; the lock also excludes writers that connect later.
      // Operators must keep services stopped through the subsequent configuration switch.
      await tx.execute(sql`lock table provider_credentials in access exclusive mode`);

      async function scan(visit: (row: Row) => Promise<void>): Promise<number> {
        let last: Row | undefined;
        let count = 0;
        for (;;) {
          const batch: Row[] = await tx
            .select()
            .from(providerCredentials)
            .where(
              last
                ? or(
                    gt(providerCredentials.userId, last.userId),
                    and(
                      eq(providerCredentials.userId, last.userId),
                      gt(providerCredentials.id, last.id),
                    ),
                  )
                : undefined,
            )
            .orderBy(asc(providerCredentials.userId), asc(providerCredentials.id))
            .limit(250);
          if (!batch.length) return count;
          for (const row of batch) await visit(row);
          count += batch.length;
          last = batch[batch.length - 1];
        }
      }

      const count = await scan(async (row) => {
        const identity = context(row);
        const plaintext = source.decrypt(identity, envelope(row));
        if (!write) return;
        const updated = await tx
          .update(providerCredentials)
          .set(target.encrypt(identity, plaintext))
          .where(
            and(eq(providerCredentials.userId, row.userId), eq(providerCredentials.id, row.id)),
          )
          .returning();
        const saved = updated[0];
        if (
          !saved ||
          updated.length !== 1 ||
          target.decrypt(identity, envelope(saved)) !== plaintext
        ) {
          throw new Error();
        }
      });
      if (write) {
        const verified = await scan(async (row) => {
          target.decrypt(context(row), envelope(row));
        });
        if (verified !== count) throw new Error();
      }
      return count;
    });
  } catch {
    throw new Error("CREDENTIAL_MAINTENANCE_FAILED");
  }
}
