import type { AiProvider, ModelDiscoveryResult } from "@neurochess/contracts";
import type { GameRepository, IdentityTransaction } from "@neurochess/database";

import type { CredentialCipher } from "../credentials/crypto.js";
import {
  createProviderCredentialAccess,
  credentialFailure,
  type ProviderOperationAccess,
} from "../credentials/provider-access.js";
import type { AiAdapters } from "../games/ai-turn.js";
import { GameRequestError } from "../games/errors.js";
import type { Principal } from "../identity/principal.js";
import { lockPrincipal } from "../identity/validity.js";
import type { Operations } from "../monitoring/operations.js";

import { discoverModels } from "./discovery.js";

export type ProviderModelService = (
  principal: Principal,
  provider: AiProvider,
  access: ProviderOperationAccess,
) => Promise<ModelDiscoveryResult>;

export function createProviderModelService(
  repository: Pick<GameRepository, "write">,
  options: {
    readonly aiAdapters: AiAdapters;
    readonly credentialCipher?: Pick<CredentialCipher, "decrypt">;
    readonly operations?: Operations;
  },
): ProviderModelService {
  const adapters = { ...options.aiAdapters };
  const useCredential = createProviderCredentialAccess(repository, options.credentialCipher);

  return async (principal, provider, access) => {
    const adapter = adapters[provider];
    const authorize = async (tx: IdentityTransaction) => {
      if (!(await lockPrincipal(tx, principal))) throw new GameRequestError("UNAUTHORIZED");
    };
    const result = await useCredential(principal, provider, access, authorize, (resolved) =>
      discoverModels(
        adapter?.provider === provider ? adapter : undefined,
        resolved,
        options.operations,
      ),
    );
    await repository.write(authorize);
    return result ?? credentialFailure;
  };
}
