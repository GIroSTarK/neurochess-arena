import { aiProviderSchema } from "@neurochess/contracts";

import type { AiAdapters } from "../../apps/api/src/games/ai-turn";
import type { MoveRequest } from "../../apps/api/src/providers/adapter";
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
        async requestMove(input: MoveRequest) {
          if (input.apiKey === "slow-fixture") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 10_000);
              input.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          }
          const base = { durationMs: 1, usage: null, providerRequestId: null };
          if (input.apiKey === "quota-fixture") {
            return { ...base, ok: false as const, error: { code: "provider_quota" as const } };
          }
          const moveIndex =
            (Number(input.context.fen.split(" ")[5]) - 1) * 2 +
            (input.context.turn === "black" ? 1 : 0);
          return {
            ...base,
            ok: true as const,
            output: {
              move:
                input.apiKey === "invalid-fixture"
                  ? "a1a8"
                  : (["f2f3", "e7e5", "g2g4", "d8h4"][moveIndex] ??
                    input.context.legalMoves[0] ??
                    "a1a8"),
            },
          };
        },
      },
    ]),
  );
}
