import type { AiProvider, ModelDescriptor } from "@neurochess/contracts";

import type { AiProviderAdapter } from "../../src/providers/adapter.js";

export function turnCatalog(provider: AiProvider): ModelDescriptor[] {
  return ["fixture-white", "fixture-black"].map((id) => ({
    provider,
    id,
    name: id,
    capabilities: {
      moveGeneration: "supported",
      parameters: {
        temperature: { min: 0, max: 2 },
        reasoningEffort: { values: ["low", "medium", "high"] },
        maxOutputTokens: { min: 1, max: 100_000 },
      },
    },
  }));
}

// Existing orchestration suites focus on inference; HTTP/discovery tests script
// their own catalogs, including capability changes and account-specific failures.
export function withTurnCatalog(adapter: AiProviderAdapter): AiProviderAdapter {
  return {
    provider: adapter.provider,
    listModels: async () => ({ ok: true, models: turnCatalog(adapter.provider) }),
    requestMove: (input) => adapter.requestMove(input),
  };
}
