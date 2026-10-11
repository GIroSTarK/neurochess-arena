import { performance } from "node:perf_hooks";

import {
  aiMoveOutputSchema,
  aiParametersSchema,
  type BillingUsage,
  type ModelDescriptor,
  type ModelDiscoveryResult,
  modelDiscoveryResultSchema,
  type NormalizedMoveResponse,
  type ProviderFailure,
  type TokenUsage,
} from "@neurochess/contracts";
import { z } from "zod";

import type { AiProviderAdapter, MoveRequest } from "./adapter.js";
import { normalizeBilling } from "./billing.js";
import { effectiveParameters } from "./discovery.js";
import {
  openRouterCapabilities,
  openRouterModelIdSchema,
  openRouterModelSchema,
  unknownOpenRouterCapabilities,
} from "./openrouter-capabilities.js";
import { openRouterRequest, openRouterUsageSchema } from "./openrouter-http.js";

const modelsSchema = z.object({
  data: z.array(openRouterModelSchema).max(1000),
  total_count: z.number().int().nonnegative().max(10_000).optional(),
  links: z.object({ next: z.string().min(1).max(2048).nullish() }).optional(),
});
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        finish_reason: z.string().min(1).max(128),
        message: z.object({
          role: z.literal("assistant"),
          content: z
            .union([
              z.string().max(64_000),
              z.array(z.object({ type: z.literal("text"), text: z.string().max(64_000) })).max(128),
            ])
            .nullish(),
          refusal: z.string().max(64_000).nullish(),
          tool_calls: z.array(z.unknown()).max(32).nullish(),
        }),
      }),
    )
    .length(1),
  usage: openRouterUsageSchema,
});
const invalidResponse: ProviderFailure = {
  code: "provider_unavailable",
  reason: "invalid_response",
};

function extractMove(raw: unknown, input: MoveRequest, durationMs: number): NormalizedMoveResponse {
  const billing = normalizeBilling("openrouter", input.modelId, raw);
  const failure = (
    error: ProviderFailure,
    usage: TokenUsage | null = null,
  ): NormalizedMoveResponse => ({
    ok: false,
    error,
    usage,
    billing,
    durationMs,
    providerRequestId: null,
  });
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) return failure(invalidResponse);
  const response = parsed.data;
  const usage = response.usage;
  const choice = response.choices[0];
  if (choice === undefined) return failure(invalidResponse, usage);
  switch (choice.finish_reason) {
    case "error":
      return failure({ code: "provider_unavailable", reason: "upstream" }, usage);
    case "length":
      return failure({ code: "model_invalid", reason: "truncated_output" }, usage);
    case "content_filter":
      return failure({ code: "model_invalid", reason: "refusal" }, usage);
    case "tool_calls":
      return failure({ code: "model_invalid", reason: "malformed_output" }, usage);
    case "stop":
      break;
    default:
      return failure(invalidResponse, usage);
  }
  if (choice.message.refusal != null) {
    return failure({ code: "model_invalid", reason: "refusal" }, usage);
  }
  if (choice.message.tool_calls?.length) {
    return failure({ code: "model_invalid", reason: "malformed_output" }, usage);
  }
  const content = choice.message.content;
  if (content == null) return failure(invalidResponse, usage);
  const text = typeof content === "string" ? content : content.map((part) => part.text).join("");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return failure({ code: "model_invalid", reason: "malformed_output" }, usage);
  }
  const output = aiMoveOutputSchema.safeParse(value);
  if (!output.success) return failure({ code: "model_invalid", reason: "malformed_output" }, usage);
  const commentary = output.data.commentary;
  return {
    ok: true,
    output:
      commentary !== undefined &&
      (commentary.includes("\0") || (input.apiKey.length > 0 && commentary.includes(input.apiKey)))
        ? { move: output.data.move }
        : output.data,
    usage,
    durationMs,
    billing,
    providerRequestId: null,
  };
}

export function createOpenRouterAdapter(transport: typeof fetch = fetch): AiProviderAdapter {
  return {
    provider: "openrouter",
    async listModels(input): Promise<ModelDiscoveryResult> {
      const models: ModelDescriptor[] = [];
      const ids = new Set<string>();
      let total: number | undefined;
      for (let page = 0; page < 100; page += 1) {
        // Compute offsets locally: upstream pagination links never receive the credential.
        const response = await openRouterRequest(transport, input, { offset: models.length });
        if (!response.ok) return { ok: false, error: response.error };
        const parsed = modelsSchema.safeParse(response.value);
        if (!parsed.success) return { ok: false, error: invalidResponse };
        const catalog = parsed.data;
        if (total !== undefined && catalog.total_count !== total) {
          return { ok: false, error: invalidResponse };
        }
        total = catalog.total_count;
        for (const model of catalog.data) {
          const name = model.name ?? model.id;
          const capabilities = openRouterCapabilities(model);
          if (
            ids.has(model.id) ||
            (input.apiKey.length > 0 &&
              [model.id, name, ...(capabilities.parameters.reasoningEffort?.values ?? [])].some(
                (value) => value.includes(input.apiKey),
              ))
          ) {
            return { ok: false, error: invalidResponse };
          }
          ids.add(model.id);
          models.push({ provider: "openrouter", id: model.id, name, capabilities });
        }
        if (models.length > 10_000 || (total !== undefined && models.length > total)) {
          return { ok: false, error: invalidResponse };
        }
        const more =
          total === undefined
            ? catalog.links?.next != null || catalog.data.length === 1000
            : models.length < total;
        if (!more) {
          if (catalog.links?.next != null) return { ok: false, error: invalidResponse };
          const result = modelDiscoveryResultSchema.safeParse({ ok: true, models });
          return result.success ? result.data : { ok: false, error: invalidResponse };
        }
        if (catalog.data.length === 0 || models.length === 10_000) {
          return { ok: false, error: invalidResponse };
        }
      }
      return { ok: false, error: invalidResponse };
    },
    async requestMove(input) {
      const started = performance.now();
      const duration = () => Math.max(0, Math.round(performance.now() - started));
      const failure = (
        error: ProviderFailure,
        usage: TokenUsage | null = null,
        billing?: BillingUsage,
      ): NormalizedMoveResponse => ({
        ok: false,
        error,
        usage,
        ...(billing === undefined ? {} : { billing }),
        durationMs: duration(),
        providerRequestId: null,
      });
      if (
        !openRouterModelIdSchema.safeParse(input.modelId).success ||
        (input.apiKey.length > 0 && input.modelId.includes(input.apiKey)) ||
        !aiParametersSchema.safeParse(input.parameters).success
      ) {
        return failure(invalidResponse);
      }
      const capabilities = input.capabilities ?? unknownOpenRouterCapabilities;
      if (capabilities.moveGeneration === "unsupported") {
        return failure({ code: "provider_unavailable", reason: "unsupported_model" });
      }
      const parameters = effectiveParameters(input.parameters, capabilities);
      if (parameters === null) return failure({ code: "provider_unavailable", reason: "upstream" });
      const { fen, pgn, color, turn, legalMoves } = input.context;
      const response = await openRouterRequest(transport, input, {
        body: {
          model: input.modelId,
          messages: [
            { role: "system", content: input.instructions },
            { role: "user", content: JSON.stringify({ fen, pgn, color, turn, legalMoves }) },
          ],
          stream: false,
          provider: { allow_fallbacks: false, require_parameters: true },
          // Compression must never silently remove history from the canonical chess context.
          plugins: [{ id: "context-compression", enabled: false }],
          ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
          ...(parameters.maxOutputTokens === undefined
            ? {}
            : { max_tokens: parameters.maxOutputTokens }),
          ...(parameters.reasoningEffort === undefined
            ? {}
            : { reasoning: { effort: parameters.reasoningEffort } }),
        },
      });
      return response.ok
        ? extractMove(response.value, input, duration())
        : failure(response.error, response.usage, response.billing);
    },
  };
}
