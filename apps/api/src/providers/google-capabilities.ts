import { type ModelCapabilities, modelIdSchema } from "@neurochess/contracts";
import { z } from "zod";

export const googleModelIdSchema = modelIdSchema.regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*(?![\s\S])/);
export const googleModelSchema = z.object({
  name: z
    .string()
    .startsWith("models/")
    .transform((name) => name.slice(7))
    .pipe(googleModelIdSchema),
  displayName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\P{Cc}+(?![\s\S])/u)
    .optional(),
  supportedGenerationMethods: z.array(z.string().min(1).max(128)).max(128).nullish(),
  outputTokenLimit: z.number().int().positive().nullish(),
  maxTemperature: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
});

export const unknownGoogleCapabilities: ModelCapabilities = {
  moveGeneration: "unknown",
  parameters: { temperature: null, reasoningEffort: null, maxOutputTokens: null },
};

export function googleCapabilities(model: z.infer<typeof googleModelSchema>): ModelCapabilities {
  const methods = model.supportedGenerationMethods;
  if (methods == null) return unknownGoogleCapabilities;
  if (!methods.includes("generateContent")) {
    return { ...unknownGoogleCapabilities, moveGeneration: "unsupported" };
  }
  return {
    moveGeneration: "supported",
    parameters: {
      temperature: model.maxTemperature == null ? null : { min: 0, max: model.maxTemperature },
      // Discovery's thinking boolean does not advertise supported levels or budgets.
      reasoningEffort: null,
      maxOutputTokens:
        model.outputTokenLimit == null ? null : { min: 1, max: model.outputTokenLimit },
    },
  };
}
