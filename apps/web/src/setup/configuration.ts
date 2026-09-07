import {
  type AiConfiguration,
  aiConfigurationSchema,
  type AiParameters,
  type ModelDescriptor,
  type ProviderId,
} from "@neurochess/contracts";

export interface SeatDraft {
  provider: ProviderId | "";
  modelId: string;
  temperature: string;
  reasoningEffort: string;
  maxOutputTokens: string;
}

export function emptySeat(provider: ProviderId | "" = ""): SeatDraft {
  return { provider, modelId: "", temperature: "", reasoningEffort: "", maxOutputTokens: "" };
}

export function seatConfiguration(
  draft: SeatDraft,
  model: ModelDescriptor | undefined,
): AiConfiguration | null {
  if (model?.id !== draft.modelId || model.provider !== draft.provider) return null;
  const supported = model.supportedParameters;
  const parameters: AiParameters = {};
  for (const name of ["temperature", "maxOutputTokens"] as const) {
    const range = supported[name];
    if (!range || draft[name] === "") continue;
    const value = Number(draft[name]);
    if (!Number.isFinite(value) || value < range.min || value > range.max) return null;
    if (name === "maxOutputTokens" && !Number.isSafeInteger(value)) return null;
    parameters[name] = value;
  }
  if (supported.reasoningEffort && draft.reasoningEffort) {
    if (!supported.reasoningEffort.values.includes(draft.reasoningEffort)) return null;
    parameters.reasoningEffort = draft.reasoningEffort;
  }
  const parsed = aiConfigurationSchema.safeParse({
    provider: draft.provider,
    modelId: draft.modelId,
    parameters,
  });
  return parsed.success ? parsed.data : null;
}
