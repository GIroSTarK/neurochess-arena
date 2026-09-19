import {
  type AiParameters,
  aiParametersSchema,
  type ModelCapabilities,
  modelIdSchema,
} from "@neurochess/contracts";
import { z } from "zod";

import { effectiveParameters } from "./discovery.js";

const support = z.object({ supported: z.boolean() });
const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
export const anthropicModelSchema = z.object({
  type: z.literal("model"),
  id: modelIdSchema,
  display_name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^\P{Cc}+$/u),
  created_at: z.iso.datetime({ offset: true }),
  max_tokens: z.number().int().positive().nullish(),
  capabilities: z
    .object({
      effort: z
        .object({
          supported: z.boolean(),
          low: support.nullish(),
          medium: support.nullish(),
          high: support.nullish(),
          xhigh: support.nullish(),
          max: support.nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

export function anthropicCapabilities(
  model: z.infer<typeof anthropicModelSchema>,
): ModelCapabilities {
  const effort = model.capabilities?.effort;
  const values = effort?.supported ? effortLevels.filter((level) => effort[level]?.supported) : [];
  return {
    moveGeneration: model.max_tokens != null || values.length > 0 ? "supported" : "unknown",
    parameters: {
      // Sampling support is absent from discovery and differs across model generations.
      temperature: null,
      reasoningEffort: values.length > 0 ? { values } : null,
      maxOutputTokens: model.max_tokens == null ? null : { min: 1, max: model.max_tokens },
    },
  };
}

export const unknownAnthropicCapabilities: ModelCapabilities = {
  moveGeneration: "unknown",
  parameters: { temperature: null, reasoningEffort: null, maxOutputTokens: null },
};

export function anthropicParameters(
  requested: Readonly<AiParameters>,
  capabilities: ModelCapabilities,
): AiParameters | null {
  if (!aiParametersSchema.safeParse(requested).success) return null;
  if (capabilities.moveGeneration === "unsupported") return {};
  const parameters = effectiveParameters(requested, capabilities);
  if (parameters === null) return null;
  // Messages requires max_tokens even when discovery cannot advertise an optional control.
  return {
    ...parameters,
    maxOutputTokens:
      parameters.maxOutputTokens ??
      Math.min(1024, capabilities.parameters.maxOutputTokens?.max ?? 1024),
  };
}
