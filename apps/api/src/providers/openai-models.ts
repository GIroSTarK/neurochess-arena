import type { ModelDescriptor, SupportedParameters } from "@neurochess/contracts";

// Compatibility metadata supplements GET /models; it never determines which IDs are listed.
// Exact documented aliases/snapshots only. Sources and update policy: docs/development.md#openai-adapter.
const profiles: readonly {
  ids: readonly string[];
  parameters: SupportedParameters;
}[] = [
  {
    ids: ["gpt-6-astra"],
    parameters: {
      reasoningEffort: { values: ["low", "medium", "high", "xhigh", "max"] },
      maxOutputTokens: { min: 16, max: 128_000 },
    },
  },
  {
    ids: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    parameters: {
      reasoningEffort: { values: ["none", "low", "medium", "high", "xhigh", "max"] },
      maxOutputTokens: { min: 16, max: 128_000 },
    },
  },
  {
    ids: ["gpt-4.1", "gpt-4.1-2025-04-14", "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"],
    parameters: {
      temperature: { min: 0, max: 2 },
      maxOutputTokens: { min: 16, max: 32_768 },
    },
  },
  {
    ids: ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"],
    parameters: {
      temperature: { min: 0, max: 2 },
      maxOutputTokens: { min: 16, max: 16_384 },
    },
  },
];

export function openAiModel(id: string): {
  descriptor: ModelDescriptor;
  structuredOutput: boolean;
} {
  const profile = profiles.find((candidate) => candidate.ids.includes(id));
  return {
    descriptor: {
      provider: "openai",
      id,
      name: id,
      supportedParameters: structuredClone(profile?.parameters ?? {}),
    },
    structuredOutput: profile !== undefined,
  };
}
