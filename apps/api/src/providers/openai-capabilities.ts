import type { ModelCapabilities } from "@neurochess/contracts";

// /models has no capability metadata. These documented profiles annotate live
// discovery; unrecognized IDs remain available with unknown capabilities.
// Sources and the conservative parameter policy are in docs/development.md.
export function openAiCapabilities(modelId: string): ModelCapabilities {
  const capabilities: ModelCapabilities = {
    moveGeneration: "unknown",
    parameters: { temperature: null, reasoningEffort: null, maxOutputTokens: null },
  };
  let maxOutputTokens: number | undefined;
  if (/^gpt-4\.1(?:-mini|-nano)?(?:-2025-04-14)?$/.test(modelId)) {
    maxOutputTokens = 32_768;
    capabilities.parameters.temperature = { min: 0, max: 2 };
  } else if (
    /^gpt-4o(?:-2024-08-06|-2024-11-20)?$/.test(modelId) ||
    /^gpt-4o-mini(?:-2024-07-18)?$/.test(modelId)
  ) {
    maxOutputTokens = 16_384;
    capabilities.parameters.temperature = { min: 0, max: 2 };
  } else if (/^gpt-5(?:-mini|-nano)?(?:-2025-08-07)?$/.test(modelId)) {
    maxOutputTokens = 128_000;
    capabilities.parameters.reasoningEffort = { values: ["minimal", "low", "medium", "high"] };
  } else if (/^gpt-5\.6(?:-sol|-terra|-luna)?$/.test(modelId)) {
    maxOutputTokens = 128_000;
    capabilities.parameters.reasoningEffort = {
      values: ["none", "low", "medium", "high", "xhigh", "max"],
    };
  } else if (modelId === "gpt-6-astra") {
    maxOutputTokens = 128_000;
    capabilities.parameters.reasoningEffort = { values: ["low", "medium", "high", "xhigh", "max"] };
  } else if (
    /^(?:text-embedding-|text-moderation-|omni-moderation-|whisper-|tts-|dall-e-|sora-|gpt-image-|gpt-realtime|gpt-audio|gpt-transcribe|gpt-live)/.test(
      modelId,
    ) ||
    /^gpt-4o(?:-mini)?-(?:audio|realtime|transcribe|tts)/.test(modelId)
  ) {
    capabilities.moveGeneration = "unsupported";
  }
  if (maxOutputTokens !== undefined) {
    capabilities.moveGeneration = "supported";
    capabilities.parameters.maxOutputTokens = { min: 16, max: maxOutputTokens };
  }
  return capabilities;
}
