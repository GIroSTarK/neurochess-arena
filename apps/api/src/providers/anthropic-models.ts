import { type ModelDescriptor, modelIdSchema } from "@neurochess/contracts";
import { z } from "zod";

const supportSchema = z.object({ supported: z.boolean() });
const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
const capabilitiesSchema = z.object({
  effort: supportSchema
    .extend({
      low: supportSchema.optional(),
      medium: supportSchema.optional(),
      high: supportSchema.optional(),
      xhigh: supportSchema.optional(),
      max: supportSchema.optional(),
    })
    .optional(),
  structured_outputs: supportSchema.optional(),
});

export const anthropicModelSchema = z.object({
  id: modelIdSchema,
  type: z.literal("model"),
  display_name: z.string().trim().min(1).max(200),
  created_at: z.iso.datetime({ offset: true }),
  max_tokens: z.number().int().positive().nullish(),
  capabilities: capabilitiesSchema.nullish(),
});

// Models API has no sampling flag. Only these verified IDs advertise temperature;
// newer models reject it. This supplements discovery, never filters availability.
// Sources and update policy: docs/development.md#anthropic-adapter.
const temperatureModels = new Set([
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
]);

export function anthropicModel(info: z.infer<typeof anthropicModelSchema>): {
  descriptor: ModelDescriptor;
  structuredOutput: boolean;
} {
  const effort = info.capabilities?.effort;
  const values = effort?.supported ? effortLevels.filter((level) => effort[level]?.supported) : [];
  return {
    descriptor: {
      provider: "anthropic",
      id: info.id,
      name: info.display_name,
      supportedParameters: {
        ...(temperatureModels.has(info.id) ? { temperature: { min: 0, max: 1 } } : {}),
        ...(info.max_tokens ? { maxOutputTokens: { min: 1, max: info.max_tokens } } : {}),
        ...(values.length ? { reasoningEffort: { values } } : {}),
      },
    },
    structuredOutput: info.capabilities?.structured_outputs?.supported === true,
  };
}
