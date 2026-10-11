import { aiProviderSchema } from "@neurochess/contracts";

import type { AiAdapters } from "../../apps/api/src/games/ai-turn";
import type { MoveRequest } from "../../apps/api/src/providers/adapter";
import { setupModels } from "../../apps/web/src/test/ai-setup";

export function setupProviders(): AiAdapters {
  const attempts = new WeakMap<AbortSignal, number>();
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
          if (
            Object.keys(input.context).sort().join(",") !== "color,fen,legalMoves,pgn,turn" ||
            /Stockfish|sf19-lite|Viewer note|opponent/i.test(JSON.stringify(input.context))
          ) {
            throw new Error("Provider context isolation failed");
          }
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
          if (input.apiKey === "expired-fixture") {
            return { ...base, ok: false as const, error: { code: "provider_auth" as const } };
          }
          if (input.apiKey === "quota-fixture") {
            return { ...base, ok: false as const, error: { code: "provider_quota" as const } };
          }
          const moveIndex =
            (Number(input.context.fen.split(" ")[5]) - 1) * 2 +
            (input.context.turn === "black" ? 1 : 0);
          const attempt = (attempts.get(input.signal) ?? 0) + 1;
          attempts.set(input.signal, attempt);
          if (moveIndex === 0 && input.apiKey === "retry-fixture") {
            return attempt === 1
              ? {
                  ...base,
                  ok: false as const,
                  error: { code: "model_invalid" as const, reason: "illegal_move" as const },
                }
              : { ...base, ok: false as const, error: { code: "provider_quota" as const } };
          }
          if (input.apiKey === "telemetry-fixture" && moveIndex === 0 && attempt < 3) {
            return {
              ...base,
              usage: attempt === 1 ? { inputTokens: 10, outputTokens: 2, totalTokens: 12 } : null,
              ok: false as const,
              error: { code: "model_invalid" as const, reason: "illegal_move" as const },
            };
          }
          const line =
            input.apiKey === "promotion-fixture"
              ? ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2", "b7a8n", "g2h1r"]
              : ["f2f3", "e7e5", "g2g4", "d8h4"];
          return {
            ...base,
            ...(input.apiKey === "telemetry-fixture" && moveIndex % 2 === 0
              ? { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
              : {}),
            ok: true as const,
            output: {
              ...(input.apiKey === "telemetry-fixture" && moveIndex % 2 === 0
                ? {
                    commentary:
                      moveIndex === 0
                        ? '<img src=x onerror="alert(1)"> **Viewer note**'
                        : "Viewer note for g4.",
                  }
                : {}),
              move:
                input.apiKey === "invalid-fixture"
                  ? "a1a8"
                  : (line[moveIndex] ?? input.context.legalMoves[0] ?? "a1a8"),
            },
          };
        },
      },
    ]),
  );
}
