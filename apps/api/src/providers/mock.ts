import {
  aiConfigurationSchema,
  type AiTelemetry,
  aiTelemetrySchema,
  modelContextSchema,
  type ModelDescriptor,
  modelDescriptorSchema,
  type ProviderDescriptor,
  providerDescriptorSchema,
  type ProviderError,
  providerErrorSchema,
} from "@neurochess/contracts";

import type { AiProviderAdapter, MoveRequest } from "./adapter.js";
import { MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { normalizeMoveResponse, resolveAiConfiguration } from "./normalization.js";

export type MockMoveStep =
  | { readonly output: unknown; readonly telemetry?: AiTelemetry }
  | { readonly error: ProviderError; readonly telemetry?: AiTelemetry };

export interface MockMoveRequest {
  readonly configuration: MoveRequest["configuration"];
  readonly context: MoveRequest["context"];
  readonly instruction: typeof MODEL_RESPONSE_INSTRUCTION;
}

export interface ScriptedMockProvider extends AiProviderAdapter {
  /** Defensive copies of model inputs; never includes apiKey or signal. */
  readonly requests: readonly MockMoveRequest[];
}

/** Test composition only: no network, environment reads, provider registry, or real model list. */
export function createScriptedMockProvider(options: {
  readonly descriptor: ProviderDescriptor;
  readonly models: readonly ModelDescriptor[];
  readonly moves: readonly MockMoveStep[];
  readonly discoveryError?: ProviderError;
}): ScriptedMockProvider {
  const descriptor = providerDescriptorSchema.safeParse(options.descriptor);
  const models = modelDescriptorSchema.array().safeParse(options.models);
  const discoveryError = providerErrorSchema.optional().safeParse(options.discoveryError);
  if (
    !descriptor.success ||
    !models.success ||
    !discoveryError.success ||
    models.data.some((model) => model.provider !== descriptor.data.id) ||
    new Set(models.data.map((model) => model.id)).size !== models.data.length
  ) {
    throw new Error("INVALID_MOCK_SCRIPT");
  }
  const moves = structuredClone(options.moves);
  const requests: MockMoveRequest[] = [];
  let index = 0;
  const emptyTelemetry: AiTelemetry = { latencyMs: 0, usage: null };

  return {
    get descriptor() {
      return { ...descriptor.data };
    },
    get requests() {
      return structuredClone(requests);
    },
    async listModels() {
      return discoveryError.data === undefined
        ? { ok: true, value: structuredClone(models.data) }
        : { ok: false, error: { ...discoveryError.data } };
    },
    async requestMove(input) {
      const context = modelContextSchema.safeParse(input.context);
      const requested = aiConfigurationSchema.safeParse(input.configuration);
      if (!requested.success) throw new Error("INVALID_MOCK_REQUEST");
      const model = models.data.find((candidate) => candidate.id === requested.data.modelId);
      const configuration = model && resolveAiConfiguration(requested.data, model);
      if (!context.success || !configuration) throw new Error("INVALID_MOCK_REQUEST");
      const step = moves[index++];
      if (step === undefined) throw new Error("MOCK_SCRIPT_EXHAUSTED");
      const telemetry = aiTelemetrySchema.safeParse(step.telemetry ?? emptyTelemetry);
      if (!telemetry.success) throw new Error("INVALID_MOCK_SCRIPT");
      requests.push({
        configuration,
        context: context.data,
        instruction: MODEL_RESPONSE_INSTRUCTION,
      });
      if ("error" in step) {
        const error = providerErrorSchema.safeParse(step.error);
        if (!error.success) throw new Error("INVALID_MOCK_SCRIPT");
        return { ok: false, error: error.data, ...telemetry.data };
      }
      return normalizeMoveResponse(step.output, context.data, telemetry.data);
    },
  };
}
