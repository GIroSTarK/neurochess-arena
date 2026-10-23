import { and, eq } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { providerCredentials } from "./schema/credentials.js";

export interface CredentialReader {
  getProviderCredential(
    userId: string,
    credentialId: string,
    provider: string,
  ): Promise<
    | Pick<
        typeof providerCredentials.$inferSelect,
        "version" | "keyId" | "nonce" | "authTag" | "ciphertext"
      >
    | undefined
  >;
}

export function credentialReaderFor(
  db: Pick<DatabaseConnection["db"], "select">,
): CredentialReader {
  return {
    async getProviderCredential(userId, credentialId, provider) {
      const [record] = await db
        .select({
          version: providerCredentials.version,
          keyId: providerCredentials.keyId,
          nonce: providerCredentials.nonce,
          authTag: providerCredentials.authTag,
          ciphertext: providerCredentials.ciphertext,
        })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.userId, userId),
            eq(providerCredentials.id, credentialId),
            eq(providerCredentials.provider, provider),
          ),
        );
      return record;
    },
  };
}
