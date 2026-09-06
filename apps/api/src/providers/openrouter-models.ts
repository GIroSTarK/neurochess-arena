import { type ModelDescriptor, modelIdSchema, reasoningEffortSchema } from "@neurochess/contracts";
import { z } from "zod";

export const openRouterModelIdSchema = modelIdSchema.refine((id) => {
  const parts = id.split("/");
  return parts.length === 2 && parts.every((part) => part && part !== "." && part !== "..");
});
const modalities = z.array(z.string()).max(32).nullish().catch(undefined);
const tokenLimit = z.number().int().positive().nullish().catch(undefined);
export const openRouterModelSchema = z.object({
  id: openRouterModelIdSchema,
  name: z.string().trim().min(1).max(200).nullish().catch(undefined),
  architecture: z.object({ input_modalities: modalities, output_modalities: modalities }).nullish(),
  supported_parameters: z.array(z.string().min(1).max(100)).max(100).nullish().catch(undefined),
  top_provider: z.object({ max_completion_tokens: tokenLimit }).nullish(),
  per_request_limits: z.object({ completion_tokens: tokenLimit }).nullish(),
  reasoning: z
    .object({
      supported_efforts: z
        .array(reasoningEffortSchema.nullable())
        .max(32)
        .nullish()
        .catch(undefined),
      mandatory: z.boolean().optional(),
    })
    .nullish(),
});

// Null explicitly means every gateway effort; absent metadata makes no such claim.
// Sources and routing constraints: docs/development.md#openrouter-adapter.
const gatewayEfforts = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];

export function openRouterModel(info: z.infer<typeof openRouterModelSchema>): {
  descriptor: ModelDescriptor;
  outputTokenParameter: "max_completion_tokens" | "max_tokens";
  responseFormat: "json_schema" | "json_object" | undefined;
} | null {
  const architecture = info.architecture;
  if (
    (architecture?.input_modalities && !architecture.input_modalities.includes("text")) ||
    (architecture?.output_modalities && !architecture.output_modalities.includes("text"))
  ) {
    return null;
  }

  const parameters = info.supported_parameters ?? [];
  const limits = [
    info.top_provider?.max_completion_tokens,
    info.per_request_limits?.completion_tokens,
  ].filter((value): value is number => value != null);
  const maxTokens = limits.length ? Math.min(...limits) : undefined;
  const efforts = info.reasoning?.supported_efforts;
  const values = [...new Set(efforts === null ? gatewayEfforts : (efforts ?? []))].filter(
    (effort): effort is string =>
      effort !== null && !(effort === "none" && info.reasoning?.mandatory),
  );
  return {
    descriptor: {
      provider: "openrouter",
      id: info.id,
      name: info.name ?? info.id,
      supportedParameters: {
        ...(parameters.includes("temperature") ? { temperature: { min: 0, max: 2 } } : {}),
        ...(maxTokens !== undefined &&
        maxTokens >= 16 &&
        parameters.some((parameter) => ["max_tokens", "max_completion_tokens"].includes(parameter))
          ? { maxOutputTokens: { min: 16, max: maxTokens } }
          : {}),
        ...(values.length ? { reasoningEffort: { values } } : {}),
      },
    },
    outputTokenParameter: parameters.includes("max_completion_tokens")
      ? "max_completion_tokens"
      : "max_tokens",
    responseFormat: parameters.includes("structured_outputs")
      ? "json_schema"
      : parameters.includes("response_format")
        ? "json_object"
        : undefined,
  };
}
