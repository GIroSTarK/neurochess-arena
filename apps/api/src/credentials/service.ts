import {
  credentialClearRequestSchema,
  type CredentialErrorCode,
  credentialListResponseSchema,
  credentialMetadataSchema,
  credentialRevokeRequestSchema,
  credentialSaveRequestSchema,
} from "@neurochess/contracts";
import type { CredentialRepository, StoredCredentialMetadata } from "@neurochess/database";

import type { AccountPrincipal } from "../identity/principal.js";

import type { CredentialCipher } from "./crypto.js";

export class CredentialRequestError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(code);
  }
}
function project(value: StoredCredentialMetadata) {
  return credentialMetadataSchema.parse({ ...value, createdAt: value.createdAt.toISOString() });
}

export function createCredentialService(
  repository: CredentialRepository,
  cipher?: Pick<CredentialCipher, "encrypt">,
) {
  return {
    async save(principal: AccountPrincipal, input: unknown) {
      const parsed = credentialSaveRequestSchema.safeParse(input);
      if (!parsed.success) throw new CredentialRequestError("CREDENTIAL_INVALID_REQUEST");
      if (!cipher) throw new CredentialRequestError("CREDENTIAL_UNAVAILABLE");
      const { apiKey, credentialId, provider, label } = parsed.data;
      const suffix = apiKey.slice(-4);
      const encrypted = cipher.encrypt(
        { userId: principal.userId, credentialId, provider },
        apiKey,
      );
      const result = await repository.save(principal, {
        id: credentialId,
        provider,
        label,
        ...encrypted,
        maskedSuffix: apiKey.length > 8 && /^[A-Za-z0-9_-]{4}$/.test(suffix) ? suffix : null,
      });
      if (!result) throw new CredentialRequestError("CREDENTIAL_UNAUTHORIZED");
      if (result === "conflict") throw new CredentialRequestError("CREDENTIAL_CONFLICT");
      if (result === "limit") throw new CredentialRequestError("CREDENTIAL_LIMIT_REACHED");
      return project(result);
    },
    async list(principal: AccountPrincipal) {
      const result = await repository.list(principal);
      if (!result) throw new CredentialRequestError("CREDENTIAL_UNAUTHORIZED");
      return credentialListResponseSchema.parse({ credentials: result.map(project) });
    },
    async revoke(principal: AccountPrincipal, input: unknown) {
      const parsed = credentialRevokeRequestSchema.safeParse(input);
      if (!parsed.success) throw new CredentialRequestError("CREDENTIAL_INVALID_REQUEST");
      if (!(await repository.revoke(principal, parsed.data.credentialId))) {
        throw new CredentialRequestError("CREDENTIAL_UNAUTHORIZED");
      }
      return { status: "deleted" as const };
    },
    async clear(principal: AccountPrincipal, input: unknown) {
      if (!credentialClearRequestSchema.safeParse(input).success) {
        throw new CredentialRequestError("CREDENTIAL_INVALID_REQUEST");
      }
      if (!(await repository.clear(principal))) {
        throw new CredentialRequestError("CREDENTIAL_UNAUTHORIZED");
      }
      return { status: "deleted" as const };
    },
  };
}
export type CredentialService = ReturnType<typeof createCredentialService>;
