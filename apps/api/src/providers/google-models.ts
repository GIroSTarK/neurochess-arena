import { type ModelDescriptor, modelIdSchema } from "@neurochess/contracts";
import { z } from "zod";

export const googleModelNameSchema = modelIdSchema.regex(
  /^models\/[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/,
);

export const googleModelSchema = z.object({
  name: googleModelNameSchema,
  displayName: z.string().trim().min(1).max(200).optional(),
  supportedGenerationMethods: z.array(z.string().min(1).max(100)).max(100).default([]),
  outputTokenLimit: z.number().int().nonnegative().optional(),
  maxTemperature: z.number().nonnegative().optional(),
  thinking: z.boolean().optional(),
});

// Exact documented compatibility supplements live discovery, never availability.
// Do not infer support from a model prefix, alias, or the thinking boolean alone.
// Sources and update policy: docs/development.md#google-adapter.
const structuredOutputModels = new Set([
  "models/gemini-3.8-flash",
  "models/gemini-3.5-flash",
  "models/gemini-3.1-pro-preview",
  "models/gemini-3.1-flash-lite",
  "models/gemini-3.1-flash-lite-preview",
  "models/gemini-2.5-pro",
  "models/gemini-2.5-flash",
  "models/gemini-2.5-flash-lite",
]);
const thinkingLevels = new Map<string, readonly string[]>([
  ...["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.1-pro-preview"].map(
    (id): [string, readonly string[]] => [`models/${id}`, ["low", "medium", "high"]],
  ),
  ...[
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
  ].map((id): [string, readonly string[]] => [
    `models/${id}`,
    ["minimal", "low", "medium", "high"],
  ]),
]);

export function googleModel(info: z.infer<typeof googleModelSchema>): {
  descriptor: ModelDescriptor;
  structuredOutput: boolean;
} | null {
  if (!info.supportedGenerationMethods.includes("generateContent")) return null;
  const levels = info.thinking === false ? undefined : thinkingLevels.get(info.name);
  return {
    descriptor: {
      provider: "google",
      id: info.name,
      name: info.displayName ?? info.name,
      supportedParameters: {
        ...(info.maxTemperature === undefined
          ? {}
          : { temperature: { min: 0, max: info.maxTemperature } }),
        ...(info.outputTokenLimit
          ? { maxOutputTokens: { min: 1, max: info.outputTokenLimit } }
          : {}),
        ...(levels ? { reasoningEffort: { values: [...levels] } } : {}),
      },
    },
    structuredOutput: structuredOutputModels.has(info.name),
  };
}
