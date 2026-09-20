import { aiProviderSchema } from "@neurochess/contracts";

import type { AiAdapters } from "../../apps/api/src/games/ai-turn";
import { setupModels } from "../../apps/web/src/test/ai-setup";

export function setupProviders(): AiAdapters {
  return Object.fromEntries(
    aiProviderSchema.options.map((provider) => [
      provider,
      {
        provider,
        async listModels({ apiKey }: { apiKey: string }) {
          if (apiKey === "rejected-fixture") {
            return { ok: false as const, error: { code: "provider_auth" as const } };
          }
          return {
            ok: true as const,
            models: apiKey === "empty-fixture" ? [] : setupModels(provider),
          };
        },
        async requestMove() {
          throw new Error("Setup tests must never execute an AI turn");
        },
      },
    ]),
  );
}
