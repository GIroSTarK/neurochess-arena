import type { ModelDescriptor, ModelDiscoveryResponse, ProviderId } from "@neurochess/contracts";

export function catalogResponse(provider: ProviderId = "openai", catalogId = crypto.randomUUID()) {
  return { ok: true, value: models(provider), catalogId } satisfies ModelDiscoveryResponse;
}

export function models(provider: ProviderId = "openai"): ModelDescriptor[] {
  return [
    {
      provider,
      id: "fixture-full",
      name: "Fixture full",
      supportedParameters: {
        temperature: { min: 0, max: 2 },
        reasoningEffort: { values: ["low", "high"] },
        maxOutputTokens: { min: 16, max: 1024 },
      },
    },
    { provider, id: "fixture-basic", name: "Fixture basic", supportedParameters: {} },
    {
      provider,
      id: "fixture-tokens",
      name: "Fixture tokens",
      supportedParameters: { maxOutputTokens: { min: 32, max: 512 } },
    },
  ];
}
