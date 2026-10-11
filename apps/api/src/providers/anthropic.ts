import { performance } from "node:perf_hooks";

import {
  aiMoveOutputSchema,
  type ModelDescriptor,
  type ModelDiscoveryResult,
  modelDiscoveryResultSchema,
  modelIdSchema,
  type NormalizedMoveResponse,
  type ProviderFailure,
  type TokenUsage,
} from "@neurochess/contracts";
import { z } from "zod";

import type { AiProviderAdapter, MoveRequest } from "./adapter.js";
import {
  anthropicCapabilities,
  anthropicModelSchema,
  anthropicParameters,
  unknownAnthropicCapabilities,
} from "./anthropic-capabilities.js";
import { anthropicRequest } from "./anthropic-http.js";
import { normalizeBilling } from "./billing.js";

const modelsSchema = z.object({
  data: z.array(anthropicModelSchema).max(1000),
  first_id: modelIdSchema.nullable(),
  last_id: modelIdSchema.nullable(),
  has_more: z.boolean(),
});
const count = z.number().int().nonnegative().nullish();
const responseSchema = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string().max(64_000) }),
        z.object({ type: z.literal("thinking") }),
        z.object({ type: z.literal("redacted_thinking") }),
      ]),
    )
    .max(128),
  stop_reason: z.enum([
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
    "refusal",
    "model_context_window_exceeded",
  ]),
  stop_sequence: z.string().max(256).nullish(),
  stop_details: z.object({ type: z.literal("refusal") }).nullish(),
  usage: z
    .object({
      input_tokens: count,
      output_tokens: count,
    })
    .nullish(),
});
const invalidResponse: ProviderFailure = {
  code: "provider_unavailable",
  reason: "invalid_response",
};

function extractMove(raw: unknown, input: MoveRequest, durationMs: number): NormalizedMoveResponse {
  const billing = normalizeBilling("anthropic", input.modelId, raw);
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
  const usage =
    response.usage == null
      ? null
      : {
          inputTokens: response.usage.input_tokens ?? null,
          outputTokens: response.usage.output_tokens ?? null,
          // Messages reports input/output separately, never a combined total.
          totalTokens: null,
        };
  if (response.stop_reason === "refusal" || response.stop_details?.type === "refusal") {
    return failure({ code: "model_invalid", reason: "refusal" }, usage);
  }
  if (
    response.stop_reason === "max_tokens" ||
    response.stop_reason === "model_context_window_exceeded"
  ) {
    return failure({ code: "model_invalid", reason: "truncated_output" }, usage);
  }
  if (response.stop_reason !== "end_turn" || response.stop_sequence != null) {
    return failure(invalidResponse, usage);
  }
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
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

export function createAnthropicAdapter(transport: typeof fetch = fetch): AiProviderAdapter {
  return {
    provider: "anthropic",
    resolveParameters: anthropicParameters,
    async listModels(input): Promise<ModelDiscoveryResult> {
      const models: ModelDescriptor[] = [];
      const ids = new Set<string>();
      let afterId: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const response = await anthropicRequest(
          transport,
          "models",
          input,
          afterId === undefined ? {} : { afterId },
        );
        if (!response.ok) return response;
        const parsed = modelsSchema.safeParse(response.value);
        if (!parsed.success) return { ok: false, error: invalidResponse };
        const catalog = parsed.data;
        if (
          catalog.first_id !== (catalog.data[0]?.id ?? null) ||
          catalog.last_id !== (catalog.data.at(-1)?.id ?? null) ||
          (catalog.has_more && catalog.data.length === 0)
        ) {
          return { ok: false, error: invalidResponse };
        }
        for (const model of catalog.data) {
          if (
            ids.has(model.id) ||
            (input.apiKey.length > 0 &&
              (model.id.includes(input.apiKey) || model.display_name.includes(input.apiKey)))
          ) {
            return { ok: false, error: invalidResponse };
          }
          ids.add(model.id);
          models.push({
            provider: "anthropic",
            id: model.id,
            name: model.display_name,
            capabilities: anthropicCapabilities(model),
          });
        }
        if (models.length > 10_000) return { ok: false, error: invalidResponse };
        if (!catalog.has_more) {
          const result = modelDiscoveryResultSchema.safeParse({ ok: true, models });
          return result.success ? result.data : { ok: false, error: invalidResponse };
        }
        if (models.length === 10_000 || catalog.last_id === null) {
          return { ok: false, error: invalidResponse };
        }
        afterId = catalog.last_id;
      }
      return { ok: false, error: invalidResponse };
    },
    async requestMove(input) {
      const started = performance.now();
      const duration = () => Math.max(0, Math.round(performance.now() - started));
      const failure = (error: ProviderFailure): NormalizedMoveResponse => ({
        ok: false,
        error,
        usage: null,
        durationMs: duration(),
        providerRequestId: null,
      });
      if (
        !modelIdSchema.safeParse(input.modelId).success ||
        (input.apiKey.length > 0 && input.modelId.includes(input.apiKey))
      ) {
        return failure(invalidResponse);
      }
      const capabilities = input.capabilities ?? unknownAnthropicCapabilities;
      if (capabilities.moveGeneration === "unsupported") {
        return failure({ code: "provider_unavailable", reason: "unsupported_model" });
      }
      const parameters = anthropicParameters(input.parameters, capabilities);
      if (parameters === null) return failure({ code: "provider_unavailable", reason: "upstream" });
      const { fen, pgn, color, turn, legalMoves } = input.context;
      const response = await anthropicRequest(transport, "messages", input, {
        body: {
          model: input.modelId,
          max_tokens: parameters.maxOutputTokens,
          system: input.instructions,
          messages: [
            { role: "user", content: JSON.stringify({ fen, pgn, color, turn, legalMoves }) },
          ],
          stream: false,
          ...(parameters.reasoningEffort === undefined
            ? {}
            : {
                output_config: { effort: parameters.reasoningEffort },
              }),
        },
      });
      return response.ok ? extractMove(response.value, input, duration()) : failure(response.error);
    },
  };
}
