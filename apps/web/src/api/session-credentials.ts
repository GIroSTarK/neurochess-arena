import {
  type AiProvider,
  aiProviderSchema,
  type ChessColor,
  chessColorSchema,
  type ProviderCredentialSource,
  providerCredentialSourceSchema,
} from "@neurochess/contracts";

import { AiRequestFailure } from "./ai-client";
import { ApiFailure } from "./failures";

export function createSessionCredentials(lifetime: AbortSignal) {
  const keys = new Map<ChessColor, { provider: AiProvider; source: ProviderCredentialSource }>();
  let disposed = false;
  const clear = () => keys.clear();
  // pagehide also covers bfcache: navigating back must require fresh key entry.
  window.addEventListener("pagehide", clear);
  function dispose() {
    disposed = true;
    clear();
    window.removeEventListener("pagehide", clear);
    lifetime.removeEventListener("abort", dispose);
  }
  lifetime.addEventListener("abort", dispose, { once: true });
  if (lifetime.aborted) dispose();
  function set(color: ChessColor, provider: AiProvider, source: ProviderCredentialSource) {
    if (disposed) throw new AiRequestFailure("AI_KEY_REQUIRED");
    const parsed = providerCredentialSourceSchema.safeParse(source);
    if (
      !parsed.success ||
      !aiProviderSchema.safeParse(provider).success ||
      !chessColorSchema.safeParse(color).success
    ) {
      throw new ApiFailure("malformed");
    }
    keys.set(color, { provider, source: parsed.data });
  }
  return {
    set(color: ChessColor, provider: AiProvider, apiKey: string) {
      set(color, provider, { apiKey });
    },
    setSaved(color: ChessColor, provider: AiProvider, credentialId: string) {
      set(color, provider, { credentialId });
    },
    require(color: ChessColor, provider: AiProvider): ProviderCredentialSource {
      const entry = keys.get(color);
      if (entry?.provider !== provider) throw new AiRequestFailure("AI_KEY_REQUIRED");
      return { ...entry.source };
    },
    remove(color: ChessColor) {
      keys.delete(color);
    },
    clear,
    dispose,
  };
}
