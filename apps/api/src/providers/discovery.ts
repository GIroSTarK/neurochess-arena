import {
  type AiParameters,
  type ModelCapabilities,
  type ModelDiscoveryResult,
  modelDiscoveryResultSchema,
} from "@neurochess/contracts";

import { observeProvider, type Operations } from "../monitoring/operations.js";

import type { AiProviderAdapter, ProviderRequestAccess } from "./adapter.js";
import { cancellationFailure } from "./invoke-move.js";

export function discoverModels(
  adapter: AiProviderAdapter | undefined,
  input: ProviderRequestAccess,
  operations?: Operations,
): Promise<ModelDiscoveryResult> {
  return observeProvider(operations, () => discoverModelsResult(adapter, input));
}

async function discoverModelsResult(
  adapter: AiProviderAdapter | undefined,
  input: ProviderRequestAccess,
): Promise<ModelDiscoveryResult> {
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  if (!adapter) {
    return { ok: false, error: { code: "provider_unavailable", reason: "unsupported_model" } };
  }
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(new Error("Discovery cancelled"));
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const raw: unknown = await Promise.race([
      Promise.resolve().then(() => {
        if (input.signal.aborted) throw new Error("Discovery cancelled");
        return adapter.listModels(input);
      }),
      cancelled.promise,
    ]);
    const result = modelDiscoveryResultSchema.safeParse(raw);
    if (
      !result.success ||
      (result.data.ok
        ? result.data.models.some(
            (model) =>
              model.provider !== adapter.provider ||
              model.id.includes(input.apiKey) ||
              model.name.includes(input.apiKey) ||
              (model.capabilities.parameters.reasoningEffort?.values.some((value) =>
                value.includes(input.apiKey),
              ) ??
                false) ||
              model.name.includes("\0"),
          )
        : result.data.error.code === "model_invalid")
    ) {
      return { ok: false, error: { code: "provider_unavailable", reason: "invalid_response" } };
    }
    return isAborted() ? { ok: false, error: cancellationFailure(input.signal) } : result.data;
  } catch {
    return {
      ok: false,
      error: isAborted()
        ? cancellationFailure(input.signal)
        : { code: "provider_unavailable", reason: "upstream" },
    };
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
}

// Null/unknown capabilities never authorize speculative parameters. Invalid values for
// an advertised control are rejected rather than silently clamped or changed.
export function effectiveParameters(
  requested: AiParameters,
  capabilities: ModelCapabilities,
): AiParameters | null {
  if (capabilities.moveGeneration !== "supported") return {};
  const supported = capabilities.parameters;
  const effective: AiParameters = {};
  if (requested.temperature !== undefined && supported.temperature) {
    if (
      requested.temperature < supported.temperature.min ||
      requested.temperature > supported.temperature.max
    ) {
      return null;
    }
    effective.temperature = requested.temperature;
  }
  if (requested.reasoningEffort !== undefined && supported.reasoningEffort) {
    if (!supported.reasoningEffort.values.includes(requested.reasoningEffort)) return null;
    effective.reasoningEffort = requested.reasoningEffort;
  }
  if (requested.maxOutputTokens !== undefined && supported.maxOutputTokens) {
    if (
      requested.maxOutputTokens < supported.maxOutputTokens.min ||
      requested.maxOutputTokens > supported.maxOutputTokens.max
    ) {
      return null;
    }
    effective.maxOutputTokens = requested.maxOutputTokens;
  }
  return effective;
}
