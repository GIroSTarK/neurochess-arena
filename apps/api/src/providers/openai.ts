import { performance } from "node:perf_hooks";

import {
  aiMoveOutputSchema,
  type ModelDiscoveryResult,
  modelDiscoveryResultSchema,
  modelIdSchema,
  type NormalizedMoveResponse,
  type ProviderFailure,
  type TokenUsage,
} from "@neurochess/contracts";
import { z } from "zod";

import type { AiProviderAdapter, MoveRequest } from "./adapter.js";
import { effectiveParameters } from "./discovery.js";
import { openAiCapabilities } from "./openai-capabilities.js";
import { openAiFailure, openAiRequest } from "./openai-http.js";

const modelsSchema = z.object({
  object: z.literal("list"),
  data: z
    .array(
      z.object({
        id: modelIdSchema,
        object: z.literal("model"),
        created: z.number().int().nonnegative(),
        owned_by: z.string().min(1).max(256),
      }),
    )
    .max(10_000),
  // The Models API returns the entire catalog; never silently accept a partial page.
  has_more: z.literal(false).optional(),
});
const count = z.number().int().nonnegative().nullish();
const usageSchema = z.object({ input_tokens: count, output_tokens: count, total_tokens: count });
const responseSchema = z.object({
  object: z.literal("response"),
  status: z.enum(["completed", "failed", "incomplete", "cancelled", "queued", "in_progress"]),
  error: z.object({ code: z.string().min(1).max(128) }).nullish(),
  incomplete_details: z.object({ reason: z.string().min(1).max(128) }).nullish(),
  usage: usageSchema.nullish(),
  output: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("reasoning") }),
        z.object({
          type: z.literal("message"),
          role: z.literal("assistant"),
          status: z.enum(["completed", "incomplete", "in_progress"]),
          content: z
            .array(
              z.discriminatedUnion("type", [
                z.object({ type: z.literal("output_text"), text: z.string().max(64_000) }),
                z.object({ type: z.literal("refusal"), refusal: z.string().max(64_000) }),
              ]),
            )
            .max(64),
        }),
      ]),
    )
    .max(128),
});
const invalidResponse: ProviderFailure = {
  code: "provider_unavailable",
  reason: "invalid_response",
};

function extractMove(raw: unknown, input: MoveRequest, durationMs: number): NormalizedMoveResponse {
  const failure = (
    error: ProviderFailure,
    usage: TokenUsage | null = null,
  ): NormalizedMoveResponse => ({
    ok: false,
    error,
    usage,
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
          totalTokens: response.usage.total_tokens ?? null,
        };
  if (
    (response.error && response.status !== "failed") ||
    (response.incomplete_details && response.status !== "incomplete")
  ) {
    return failure(invalidResponse, usage);
  }
  if (response.status === "failed") {
    return failure(response.error ? openAiFailure(0, response.error.code) : invalidResponse, usage);
  }
  if (response.status === "cancelled") {
    return failure({ code: "provider_unavailable", reason: "cancelled" }, usage);
  }
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    return failure(
      reason === "max_output_tokens"
        ? { code: "model_invalid", reason: "truncated_output" }
        : reason === "content_filter"
          ? { code: "model_invalid", reason: "refusal" }
          : invalidResponse,
      usage,
    );
  }
  if (response.status !== "completed") {
    return failure(invalidResponse, usage);
  }
  const text: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    if (item.status !== "completed") return failure(invalidResponse, usage);
    for (const content of item.content) {
      if (content.type === "refusal") {
        return failure({ code: "model_invalid", reason: "refusal" }, usage);
      }
      text.push(content.text);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text.join("")) as unknown;
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
    // Omit upstream identifiers entirely, even if an upstream header echoes a key.
    providerRequestId: null,
  };
}

export function createOpenAiAdapter(transport: typeof fetch = fetch): AiProviderAdapter {
  return {
    provider: "openai",
    async listModels(input): Promise<ModelDiscoveryResult> {
      const response = await openAiRequest(transport, "models", input);
      if (!response.ok) return response;
      const parsed = modelsSchema.safeParse(response.value);
      if (
        !parsed.success ||
        parsed.data.data.some(({ id }) => input.apiKey.length > 0 && id.includes(input.apiKey))
      ) {
        return { ok: false, error: invalidResponse };
      }
      const result = modelDiscoveryResultSchema.safeParse({
        ok: true,
        models: parsed.data.data.map(({ id }) => ({
          provider: "openai",
          id,
          name: id,
          capabilities: openAiCapabilities(id),
        })),
      });
      return result.success ? result.data : { ok: false, error: invalidResponse };
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
      const capabilities = openAiCapabilities(input.modelId);
      if (capabilities.moveGeneration === "unsupported") {
        return failure({ code: "provider_unavailable", reason: "unsupported_model" });
      }
      const parameters = effectiveParameters(input.parameters, capabilities);
      if (parameters === null) return failure({ code: "provider_unavailable", reason: "upstream" });
      const { fen, pgn, color, turn, legalMoves } = input.context;
      const response = await openAiRequest(transport, "responses", input, {
        model: input.modelId,
        instructions: input.instructions,
        input: JSON.stringify({ fen, pgn, color, turn, legalMoves }),
        store: false,
        background: false,
        ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
        ...(parameters.reasoningEffort === undefined
          ? {}
          : { reasoning: { effort: parameters.reasoningEffort } }),
        ...(parameters.maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: parameters.maxOutputTokens }),
      });
      return response.ok ? extractMove(response.value, input, duration()) : failure(response.error);
    },
  };
}
