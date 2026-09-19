import {
  type AiProvider,
  aiProviderSchema,
  type ChessColor,
  chessColorSchema,
  sessionApiKeySchema,
} from "@neurochess/contracts";

import { AiRequestFailure } from "./ai-client";
import { ApiFailure } from "./client";

export function createSessionCredentials(lifetime: AbortSignal) {
  const keys = new Map<ChessColor, { provider: AiProvider; apiKey: string }>();
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
  return {
    set(color: ChessColor, provider: AiProvider, apiKey: string) {
      if (disposed) throw new AiRequestFailure("AI_KEY_REQUIRED");
      const parsed = sessionApiKeySchema.safeParse(apiKey);
      if (
        !parsed.success ||
        !aiProviderSchema.safeParse(provider).success ||
        !chessColorSchema.safeParse(color).success
      ) {
        throw new ApiFailure("malformed");
      }
      keys.set(color, { provider, apiKey: parsed.data });
    },
    require(color: ChessColor, provider: AiProvider): string {
      const entry = keys.get(color);
      if (entry?.provider !== provider) throw new AiRequestFailure("AI_KEY_REQUIRED");
      return entry.apiKey;
    },
    remove(color: ChessColor) {
      keys.delete(color);
    },
    clear,
    dispose,
  };
}
