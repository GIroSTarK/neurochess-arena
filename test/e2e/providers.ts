import type { ProviderDescriptor } from "@neurochess/contracts";

import type { AiProviderAdapter } from "../../apps/api/src/providers/adapter";
import { models } from "../ai-models";

export const setupProviders = (
  [
    { id: "openai", name: "OpenAI" },
    { id: "anthropic", name: "Anthropic" },
    { id: "google", name: "Google" },
    { id: "openrouter", name: "OpenRouter" },
  ] satisfies ProviderDescriptor[]
).map((descriptor) => ({
  adapter: {
    descriptor,
    async listModels(input) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (input.apiKey === "fixture-empty") return { ok: true, value: [] };
      if (input.apiKey === "fixture-auth") return { ok: false, error: { kind: "provider_auth" } };
      if (["fixture-white-disjoint", "fixture-black-disjoint"].includes(input.apiKey)) {
        const color = input.apiKey === "fixture-white-disjoint" ? "white" : "black";
        return {
          ok: true,
          value: [
            {
              provider: descriptor.id,
              id: `${color}-only-model`,
              name: `${color}-only model`,
              supportedParameters: {},
            },
          ],
        };
      }
      return { ok: true, value: models(descriptor.id) };
    },
    async requestMove(input) {
      const delay = input.apiKey === "fixture-playback-slow" ? 11_000 : 1_500;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", finish);
          resolve();
        };
        // Setup-only fixtures hold their first turn so creation/recovery assertions remain
        // independent of playback. Every provider operation here is an in-process mock.
        const timer = input.apiKey.startsWith("fixture-playback")
          ? setTimeout(finish, delay)
          : undefined;
        input.signal?.addEventListener("abort", finish, { once: true });
        if (input.signal?.aborted) finish();
      });
      if (input.signal?.aborted) {
        return { ok: false, error: { kind: "provider_unavailable" }, latencyMs: 0, usage: null };
      }
      const move = ["f2f3", "e7e5", "g2g4", "d8h4"].find((move) =>
        input.context.legalMoves.includes(move),
      );
      if (!move) throw new Error("PLAYBACK_FIXTURE_EXHAUSTED");
      return { ok: true, value: { move, latencyMs: delay, usage: null } };
    },
  } satisfies AiProviderAdapter,
}));
