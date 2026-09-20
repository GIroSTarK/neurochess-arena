import {
  type ModelCapabilities,
  modelIdSchema,
  reasoningEffortSchema,
} from "@neurochess/contracts";
import { z } from "zod";

export const openRouterModelIdSchema = modelIdSchema.regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._+-]*(?:[/:][a-zA-Z0-9][a-zA-Z0-9._+-]*)*(?![\s\S])/,
);
const modalities = z.array(z.string().min(1).max(64)).max(32).nullish();
export const openRouterModelSchema = z.object({
  id: openRouterModelIdSchema,
  name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^\P{Cc}+(?![\s\S])/u)
    .optional(),
  architecture: z.object({ input_modalities: modalities, output_modalities: modalities }).nullish(),
  supported_parameters: z.array(z.string().min(1).max(128)).max(128).nullish(),
  top_provider: z
    .object({ max_completion_tokens: z.number().int().positive().nullish() })
    .nullish(),
  reasoning: z
    .object({
      mandatory: z.boolean().optional(),
      supported_efforts: z
        .array(reasoningEffortSchema.nullable())
        .max(32)
        .transform((values) => values.filter((value) => value !== null))
        .refine((values) => new Set(values).size === values.length)
        .nullish(),
    })
    .nullish(),
});

export const unknownOpenRouterCapabilities: ModelCapabilities = {
  moveGeneration: "unknown",
  parameters: { temperature: null, reasoningEffort: null, maxOutputTokens: null },
};

export function openRouterCapabilities(
  model: z.infer<typeof openRouterModelSchema>,
): ModelCapabilities {
  const input = model.architecture?.input_modalities;
  const output = model.architecture?.output_modalities;
  if ((input != null && !input.includes("text")) || (output != null && !output.includes("text"))) {
    return { ...unknownOpenRouterCapabilities, moveGeneration: "unsupported" };
  }
  if (input == null || output == null) return unknownOpenRouterCapabilities;
  const supported = model.supported_parameters ?? [];
  // Explicit null advertises all gateway efforts; absence advertises no effort selector.
  const efforts =
    model.reasoning?.supported_efforts === null
      ? ["max", "xhigh", "high", "medium", "low", "minimal", "none"]
      : (model.reasoning?.supported_efforts ?? []);
  const values = efforts.filter((value) => value !== "none" || model.reasoning?.mandatory !== true);
  const max = model.top_provider?.max_completion_tokens;
  return {
    moveGeneration: "supported",
    parameters: {
      temperature: supported.includes("temperature") ? { min: 0, max: 2 } : null,
      reasoningEffort: supported.includes("reasoning") && values.length > 0 ? { values } : null,
      maxOutputTokens: supported.includes("max_tokens") && max != null ? { min: 1, max } : null,
    },
  };
}
