import { and, asc, eq, gt } from "drizzle-orm";

import { hasAccountSession, lockAccountSession } from "./account-session.js";
import type { DatabaseConnection } from "./client.js";
import { providerCredentials } from "./schema/credentials.js";

const metadata = {
  id: providerCredentials.id,
  provider: providerCredentials.provider,
  label: providerCredentials.label,
  maskedSuffix: providerCredentials.maskedSuffix,
  createdAt: providerCredentials.createdAt,
};
export type StoredCredentialMetadata = Pick<
  typeof providerCredentials.$inferSelect,
  keyof typeof metadata
>;
export type NewProviderCredential = Omit<
  typeof providerCredentials.$inferInsert,
  "userId" | "createdAt"
>;
const encryptedMaterial = {
  version: providerCredentials.version,
  keyId: providerCredentials.keyId,
  nonce: providerCredentials.nonce,
  authTag: providerCredentials.authTag,
  ciphertext: providerCredentials.ciphertext,
};

// The caller holds the account/session locks shared with save, revoke, and clear.
export async function readProviderCredential(
  db: Pick<DatabaseConnection["db"], "select">,
  userId: string,
  id: string,
  provider: typeof providerCredentials.$inferSelect.provider,
) {
  const [record] = await db
    .select(encryptedMaterial)
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, userId),
        eq(providerCredentials.id, id),
        eq(providerCredentials.provider, provider),
      ),
    );
  return record;
}
export interface CredentialRepository {
  save(
    userId: string,
    sessionId: string,
    credential: NewProviderCredential,
  ): Promise<StoredCredentialMetadata | undefined>;
  list(
    userId: string,
    sessionId: string,
    after?: string,
  ): Promise<StoredCredentialMetadata[] | undefined>;
  revoke(userId: string, sessionId: string, id: string): Promise<boolean | undefined>;
  clear(userId: string, sessionId: string): Promise<true | undefined>;
}
type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];
class ExpiredCredentialSession extends Error {}

export function createCredentialRepository(database: DatabaseConnection): CredentialRepository {
  const operate = async <T>(
    userId: string,
    sessionId: string,
    mode: "share" | "update",
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await database.db.transaction(async (tx) => {
        if (!(await lockAccountSession(tx, userId, sessionId, mode))) return undefined;
        const result = await operation(tx);
        // SQL can wait on a record/index lock beyond the calling session's expiry.
        if (!(await hasAccountSession(tx, userId, sessionId))) throw new ExpiredCredentialSession();
        return result;
      });
    } catch (error) {
      if (error instanceof ExpiredCredentialSession) return undefined;
      throw error;
    }
  };
  return {
    save: (userId, sessionId, credential) =>
      operate(userId, sessionId, "update", async (tx) => {
        const [created] = await tx
          .insert(providerCredentials)
          .values({ ...credential, userId })
          .returning(metadata);
        return created;
      }),
    list: (userId, sessionId, after) =>
      operate(userId, sessionId, "share", async (tx) =>
        tx
          .select(metadata)
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.userId, userId),
              after ? gt(providerCredentials.id, after) : undefined,
            ),
          )
          .orderBy(asc(providerCredentials.id))
          .limit(51),
      ),
    revoke: (userId, sessionId, id) =>
      operate(userId, sessionId, "update", async (tx) => {
        const removed = await tx
          .delete(providerCredentials)
          .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.id, id)))
          .returning({ id: providerCredentials.id });
        return removed.length === 1;
      }),
    clear: (userId, sessionId) =>
      operate(userId, sessionId, "update", async (tx) => {
        await tx.delete(providerCredentials).where(eq(providerCredentials.userId, userId));
        return true as const;
      }),
  };
}
