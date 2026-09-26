import {
  type AiProvider,
  type ProviderCredentialSource,
  providerCredentialSourceSchema,
  type ProviderFailure,
} from "@neurochess/contracts";
import type { GameTransaction } from "@neurochess/database";

import { GameRequestError } from "../games/errors.js";
import type { Principal } from "../identity/principal.js";
import { requireActivePrincipal } from "../identity/validity.js";
import { cancellationFailure } from "../providers/invoke-move.js";

import type { CredentialCipher } from "./encryption.js";

export type ProviderOperationAccess = ProviderCredentialSource & { readonly signal: AbortSignal };
type CredentialResolution = { ok: true; apiKey: string } | { ok: false; error: ProviderFailure };

export function validateProviderAccess(principal: Principal, access: ProviderOperationAccess) {
  const { signal, ...source } = access;
  const parsed = providerCredentialSourceSchema.safeParse(source);
  if (!parsed.success || !(signal instanceof AbortSignal)) {
    throw new GameRequestError("INVALID_REQUEST");
  }
  if ("credentialId" in parsed.data && principal.kind !== "account") {
    throw new GameRequestError("FORBIDDEN");
  }
}

// Call only after locking and authorizing the operation. Never carry the result into game data.
export async function resolveProviderCredential(
  tx: GameTransaction,
  principal: Principal,
  provider: AiProvider,
  access: ProviderOperationAccess,
  cipher?: CredentialCipher,
): Promise<CredentialResolution> {
  const isAborted = () => access.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(access.signal) };
  if ("apiKey" in access) return { ok: true, apiKey: access.apiKey };
  if (principal.kind !== "account") throw new GameRequestError("FORBIDDEN");
  const credentialId = access.credentialId.toLowerCase();
  const record = await tx.getProviderCredential(principal.userId, credentialId, provider);
  await requireActivePrincipal(tx, principal);
  if (isAborted()) return { ok: false, error: cancellationFailure(access.signal) };
  if (record && cipher) {
    try {
      return {
        ok: true,
        apiKey: cipher.decrypt({ userId: principal.userId, credentialId, provider }, record),
      };
    } catch {
      // Unavailable key versions and corrupted ciphertext have the same safe recovery path.
    }
  }
  return { ok: false, error: { code: "provider_auth" } };
}
