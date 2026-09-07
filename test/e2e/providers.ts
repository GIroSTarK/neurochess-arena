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
    requestMove() {
      throw new Error("AI_SETUP_MUST_NOT_EXECUTE_TURNS");
    },
  } satisfies AiProviderAdapter,
}));
