import {
  type AiConfiguration,
  aiConfigurationSchema,
  aiMoveResponseSchema,
  type AiTelemetry,
  aiTelemetrySchema,
  type ModelContext,
  type ModelDescriptor,
  modelDescriptorSchema,
  type NormalizedMoveResponse,
} from "@neurochess/contracts";

/** Unsupported known parameters are omitted; supported values must satisfy actual limits. */
export function resolveAiConfiguration(
  configuration: AiConfiguration,
  model: ModelDescriptor,
): AiConfiguration | null {
  const parsed = aiConfigurationSchema.safeParse(configuration);
  const descriptor = modelDescriptorSchema.safeParse(model);
  if (
    !parsed.success ||
    !descriptor.success ||
    parsed.data.provider !== descriptor.data.provider ||
    parsed.data.modelId !== descriptor.data.id
  ) {
    return null;
  }
  const parameters: AiConfiguration["parameters"] = {};
  const supported = descriptor.data.supportedParameters;
  for (const key of ["temperature", "maxOutputTokens"] as const) {
    const value = parsed.data.parameters[key];
    const range = supported[key];
    if (value !== undefined && range !== undefined) {
      if (value < range.min || value > range.max) return null;
      parameters[key] = value;
    }
  }
  const effort = parsed.data.parameters.reasoningEffort;
  if (effort !== undefined && supported.reasoningEffort !== undefined) {
    if (!supported.reasoningEffort.values.includes(effort)) return null;
    parameters.reasoningEffort = effort;
  }
  return { ...parsed.data, parameters };
}

export function normalizeMoveResponse(
  output: unknown,
  context: ModelContext,
  telemetry: AiTelemetry,
): NormalizedMoveResponse {
  const parsedTelemetry = aiTelemetrySchema.safeParse(telemetry);
  if (!parsedTelemetry.success) {
    // Internal adapter error, not a model mistake. Never expose Zod issues or raw usage.
    throw new Error("INVALID_PROVIDER_TELEMETRY");
  }
  let payload: unknown = output;
  if (typeof output === "string") {
    try {
      payload = JSON.parse(output);
    } catch {
      payload = undefined;
    }
  }
  const parsed = aiMoveResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: { kind: "model_invalid", reason: "malformed_output" },
      ...parsedTelemetry.data,
    };
  }
  if (!context.legalMoves.includes(parsed.data.move)) {
    return {
      ok: false,
      error: { kind: "model_invalid", reason: "illegal_move" },
      ...parsedTelemetry.data,
    };
  }
  return { ok: true, value: { ...parsed.data, ...parsedTelemetry.data } };
}
