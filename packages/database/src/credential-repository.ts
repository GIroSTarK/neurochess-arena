import { and, desc, eq, gt, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { session, user } from "./schema/auth.js";
import { providerCredentials } from "./schema/credentials.js";

interface CredentialIdentity {
  readonly userId: string;
  readonly sessionId: string;
}
type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];
const metadata = {
  credentialId: providerCredentials.id,
  provider: providerCredentials.provider,
  label: providerCredentials.label,
  maskedSuffix: providerCredentials.maskedSuffix,
  createdAt: providerCredentials.createdAt,
};
export type NewCredential = Omit<typeof providerCredentials.$inferInsert, "userId" | "createdAt">;
export interface StoredCredentialMetadata {
  credentialId: string;
  provider: string;
  label: string;
  maskedSuffix: string | null;
  createdAt: Date;
}
export interface CredentialRepository {
  save(
    identity: CredentialIdentity,
    value: NewCredential,
  ): Promise<StoredCredentialMetadata | "conflict" | "limit" | undefined>;
  list(identity: CredentialIdentity): Promise<StoredCredentialMetadata[] | undefined>;
  revoke(identity: CredentialIdentity, credentialId: string): Promise<true | undefined>;
  clear(identity: CredentialIdentity): Promise<true | undefined>;
}
class CredentialSessionExpiredError extends Error {}

async function valid(tx: Transaction, identity: CredentialIdentity) {
  const [record] = await tx
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.userId, identity.userId),
        eq(session.id, identity.sessionId),
        gt(session.expiresAt, sql`clock_timestamp() at time zone 'UTC'`),
      ),
    );
  return Boolean(record);
}

export function createCredentialRepository(database: DatabaseConnection): CredentialRepository {
  async function authorized<T>(
    identity: CredentialIdentity,
    action: (tx: Transaction) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await database.db.transaction(async (tx) => {
        // Same lock as auth revocation and account commands; take it before credential locks.
        const [owner] = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, identity.userId))
          .for("update");
        if (!owner || !(await valid(tx, identity))) return undefined;
        const result = await action(tx);
        // A row or unique-index wait can outlast the session. Roll back every mutation.
        if (!(await valid(tx, identity))) throw new CredentialSessionExpiredError();
        return result;
      });
    } catch (error) {
      if (error instanceof CredentialSessionExpiredError) return undefined;
      throw error;
    }
  }
  return {
    save: (identity, value) =>
      authorized(identity, async (tx) => {
        const [existing] = await tx
          .select({ id: providerCredentials.id })
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.userId, identity.userId),
              eq(providerCredentials.id, value.id),
            ),
          );
        if (existing) return "conflict" as const;
        if (
          (await tx.$count(providerCredentials, eq(providerCredentials.userId, identity.userId))) >=
          100
        ) {
          return "limit" as const;
        }
        const [record] = await tx
          .insert(providerCredentials)
          .values({ ...value, userId: identity.userId })
          .onConflictDoNothing({ target: [providerCredentials.userId, providerCredentials.id] })
          .returning(metadata);
        return record ?? ("conflict" as const);
      }),
    list: (identity) =>
      authorized(identity, (tx) =>
        tx
          .select(metadata)
          .from(providerCredentials)
          .where(eq(providerCredentials.userId, identity.userId))
          .orderBy(desc(providerCredentials.createdAt), desc(providerCredentials.id))
          .limit(100),
      ),
    revoke: (identity, credentialId) =>
      authorized(identity, async (tx) => {
        await tx
          .delete(providerCredentials)
          .where(
            and(
              eq(providerCredentials.userId, identity.userId),
              eq(providerCredentials.id, credentialId),
            ),
          );
        return true as const;
      }),
    clear: (identity) =>
      authorized(identity, async (tx) => {
        await tx.delete(providerCredentials).where(eq(providerCredentials.userId, identity.userId));
        return true as const;
      }),
  };
}
