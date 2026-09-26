import { randomUUID } from "node:crypto";

import {
  type CredentialErrorCode,
  credentialIdParamsSchema,
  credentialListQuerySchema,
  type CredentialListResponse,
  credentialMetadataSchema,
  credentialSaveRequestSchema,
} from "@neurochess/contracts";
import type { CredentialRepository, StoredCredentialMetadata } from "@neurochess/database";

import type { AccountPrincipal } from "../identity/principal.js";

import type { CredentialCipher } from "./encryption.js";

export class CredentialRequestError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super("CREDENTIAL_REQUEST_FAILED");
    this.name = "CredentialRequestError";
  }
}

function project(record: StoredCredentialMetadata) {
  return credentialMetadataSchema.parse({
    credentialId: record.id,
    provider: record.provider,
    label: record.label,
    maskedSuffix: record.maskedSuffix,
    createdAt: record.createdAt.toISOString(),
  });
}

async function authorized<T>(operation: () => Promise<T | undefined>): Promise<T> {
  try {
    const result = await operation();
    if (result === undefined) throw new CredentialRequestError("CREDENTIAL_UNAUTHORIZED");
    return result;
  } catch (error) {
    if (error instanceof CredentialRequestError) throw error;
    // Database and cryptography diagnostics may contain secret-bearing input.
    throw new CredentialRequestError("CREDENTIAL_UNAVAILABLE");
  }
}

export function createCredentialService(
  repository: CredentialRepository,
  cipher?: CredentialCipher,
) {
  return {
    save(principal: AccountPrincipal, input: unknown) {
      return authorized(async () => {
        const parsed = credentialSaveRequestSchema.safeParse(input);
        if (!parsed.success) throw new CredentialRequestError("CREDENTIAL_INVALID_REQUEST");
        if (!cipher) throw new CredentialRequestError("CREDENTIAL_STORAGE_DISABLED");
        const { apiKey, provider, label } = parsed.data;
        const id = randomUUID();
        const suffix = apiKey.slice(-4);
        const encrypted = cipher.encrypt(
          { credentialId: id, userId: principal.userId, provider },
          apiKey,
        );
        const saved = await repository.save(principal.userId, principal.sessionId, {
          id,
          provider,
          label,
          maskedSuffix: apiKey.length >= 8 && /^[A-Za-z0-9_-]{4}$/.test(suffix) ? suffix : null,
          ...encrypted,
        });
        return saved ? project(saved) : undefined;
      });
    },
    list(principal: AccountPrincipal, input: unknown): Promise<CredentialListResponse> {
      return authorized(async () => {
        const query = credentialListQuerySchema.safeParse(input);
        if (!query.success) throw new CredentialRequestError("CREDENTIAL_INVALID_REQUEST");
        const records = await repository.list(
          principal.userId,
          principal.sessionId,
          query.data.after,
        );
        if (!records) return undefined;
        const page = records.slice(0, 50);
        const last = page.at(-1);
        return {
          credentials: page.map(project),
          nextCursor: records.length > 50 && last ? last.id : null,
        };
      });
    },
    async revoke(principal: AccountPrincipal, credentialId: string): Promise<void> {
      if (!credentialIdParamsSchema.safeParse({ credentialId }).success) {
        throw new CredentialRequestError("CREDENTIAL_INVALID_REQUEST");
      }
      const removed = await authorized(() =>
        repository.revoke(principal.userId, principal.sessionId, credentialId),
      );
      if (!removed) throw new CredentialRequestError("CREDENTIAL_NOT_FOUND");
    },
    async clear(principal: AccountPrincipal): Promise<void> {
      await authorized(() => repository.clear(principal.userId, principal.sessionId));
    },
  };
}
export type CredentialService = ReturnType<typeof createCredentialService>;
