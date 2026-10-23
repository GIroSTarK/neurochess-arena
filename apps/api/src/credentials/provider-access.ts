import { isDeepStrictEqual } from "node:util";

import type { AiProvider, ProviderCredentialSource } from "@neurochess/contracts";
import type { GameRepository, GameTransaction } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { requireActivePrincipal } from "../identity/validity.js";
import type { ListModelsInput } from "../providers/adapter.js";

import type { CredentialCipher } from "./crypto.js";

export type ProviderOperationAccess = ProviderCredentialSource & { readonly signal: AbortSignal };
export const credentialFailure = { ok: false, error: { code: "provider_auth" } } as const;

export function createProviderCredentialAccess(
  repository: Pick<GameRepository, "write">,
  cipher?: Pick<CredentialCipher, "decrypt">,
) {
  return async function useCredential<T>(
    principal: Principal,
    provider: AiProvider,
    source: ProviderOperationAccess,
    authorize: (tx: GameTransaction) => Promise<unknown>,
    operation: (input: ListModelsInput) => Promise<T>,
  ): Promise<T | null> {
    const access = await repository.write(async (tx) => {
      await authorize(tx);
      if ("apiKey" in source) return { apiKey: source.apiKey, signal: source.signal };
      if (principal.kind !== "account" || !cipher) return null;
      const envelope = await tx.getProviderCredential(
        principal.userId,
        source.credentialId,
        provider,
      );
      await requireActivePrincipal(tx, principal);
      if (!envelope) return null;
      let apiKey: string;
      try {
        apiKey = cipher.decrypt(
          { userId: principal.userId, credentialId: source.credentialId, provider },
          envelope,
        );
      } catch {
        return null;
      }
      return {
        apiKey,
        signal: source.signal,
        // Pagination is another dispatch. Revoke/re-save of an ID cannot reuse this operation's key.
        beforeDispatch: () =>
          repository.write(async (next) => {
            await authorize(next);
            const current = await next.getProviderCredential(
              principal.userId,
              source.credentialId,
              provider,
            );
            await requireActivePrincipal(next, principal);
            return isDeepStrictEqual(current, envelope) ? null : credentialFailure.error;
          }),
      };
    });
    if (!access) return null;
    try {
      return await operation(access);
    } finally {
      access.apiKey = "";
    }
  };
}

export type ProviderCredentialAccess = ReturnType<typeof createProviderCredentialAccess>;
