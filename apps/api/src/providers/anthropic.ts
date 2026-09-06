import {
  aiConfigurationSchema,
  type AiTelemetry,
  modelContextSchema,
  type ModelDescriptor,
  modelIdSchema,
  modelListSchema,
  type ProviderError,
  sessionCredentialSchema,
} from "@neurochess/contracts";
import { z } from "zod";

import type { AiProviderAdapter, ListModelsInput } from "./adapter.js";
import { anthropicModel, anthropicModelSchema } from "./anthropic-models.js";
import { MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { normalizeMoveResponse, resolveAiConfiguration } from "./normalization.js";

const modelsSchema = z.object({
  data: z.array(anthropicModelSchema).max(1_000),
  has_more: z.boolean(),
  first_id: modelIdSchema.nullable(),
  last_id: modelIdSchema.nullable(),
});
const messageSchema = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  stop_reason: z.enum([
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
    "refusal",
    "model_context_window_exceeded",
  ]),
  stop_details: z.unknown().optional(),
  content: z.unknown().optional(),
  usage: z.unknown().optional(),
});
const contentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("thinking") }),
    z.object({ type: z.literal("redacted_thinking") }),
  ]),
);
const tokenCount = z.number().int().nonnegative().nullable().catch(null);
const usageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount.optional(),
  cache_read_input_tokens: tokenCount.optional(),
});
const requestIdSchema = z
  .string()
  .max(200)
  .regex(/^req_[a-zA-Z0-9_-]+(?![\s\S])/);

type JsonResult = ({ ok: true; value: unknown } | { ok: false; error: ProviderError }) & {
  providerRequestId?: string;
};

export function createAnthropicProvider(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
    readonly timeoutMs?: number;
  } = {},
): AiProviderAdapter {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("INVALID_ANTHROPIC_TIMEOUT");
  }

  async function requestJson(
    path: string,
    input: ListModelsInput,
    body?: object,
  ): Promise<JsonResult> {
    const timeout = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const headers = new Headers({
      Accept: "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    });
    try {
      signal.throwIfAborted();
      if (body) headers.set("Content-Type", "application/json");
      const response = await fetch(`https://api.anthropic.com/v1/${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: "error",
      });
      signal.throwIfAborted();
      const rawId = response.headers.get("request-id");
      rejectCredentialEcho(rawId, input.apiKey);
      const id = requestIdSchema.safeParse(rawId);
      const telemetry = id.success ? { providerRequestId: id.data } : {};
      if (!response.ok) {
        // Classify by status without retaining upstream messages or request objects.
        await response.body?.cancel();
        signal.throwIfAborted();
        return { ok: false, error: httpError(response.status), ...telemetry };
      }
      const value: unknown = await response.json();
      signal.throwIfAborted();
      return { ok: true, value, ...telemetry };
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          kind:
            timeout.signal.aborted || (error instanceof Error && error.name === "TimeoutError")
              ? "provider_timeout"
              : "provider_unavailable",
        },
      };
    } finally {
      clearTimeout(timer);
      headers.delete("x-api-key");
    }
  }

  return {
    get descriptor() {
      return { id: "anthropic" as const, name: "Anthropic" };
    },
    async listModels(input) {
      validateInput(input);
      const models: ModelDescriptor[] = [];
      const ids = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const result = await requestJson(
          `models?limit=1000${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}`,
          input,
        );
        if (!result.ok) return { ok: false, error: result.error };
        const parsed = modelsSchema.safeParse(result.value);
        if (!parsed.success) throw new Error("INVALID_ANTHROPIC_RESPONSE");
        const { data, first_id, last_id, has_more } = parsed.data;
        if (
          first_id !== (data[0]?.id ?? null) ||
          last_id !== (data.at(-1)?.id ?? null) ||
          models.length + data.length > 2_000
        ) {
          throw new Error("INVALID_ANTHROPIC_RESPONSE");
        }
        for (const info of data) {
          rejectCredentialEcho(info.id, input.apiKey);
          rejectCredentialEcho(info.display_name, input.apiKey);
          if (ids.has(info.id)) throw new Error("INVALID_ANTHROPIC_RESPONSE");
          ids.add(info.id);
          models.push(anthropicModel(info).descriptor);
        }
        if (!has_more) return { ok: true, value: modelListSchema.parse(models) };
        if (!last_id || data.length === 0 || models.length === 2_000) {
          throw new Error("INVALID_ANTHROPIC_RESPONSE");
        }
        cursor = last_id;
      }
      throw new Error("INVALID_ANTHROPIC_RESPONSE");
    },
    async requestMove(input) {
      validateInput(input);
      const requested = aiConfigurationSchema.safeParse(input.configuration);
      const context = modelContextSchema.safeParse(input.context);
      if (
        !requested.success ||
        requested.data.provider !== "anthropic" ||
        !context.success ||
        [".", ".."].includes(requested.data.modelId) ||
        requested.data.modelId.includes(input.apiKey)
      ) {
        throw new Error("INVALID_ANTHROPIC_REQUEST");
      }
      const started = now();
      // Resolve live capabilities with this request's key; persisted games need no warm cache.
      const metadata = await requestJson(
        `models/${encodeURIComponent(requested.data.modelId)}`,
        input,
      );
      if (!metadata.ok) return { ...metadata, latencyMs: now() - started, usage: null };
      const info = anthropicModelSchema.safeParse(metadata.value);
      if (!info.success) {
        return {
          ok: false,
          error: { kind: "provider_unavailable" },
          latencyMs: now() - started,
          usage: null,
        };
      }
      rejectCredentialEcho(info.data.id, input.apiKey);
      rejectCredentialEcho(info.data.display_name, input.apiKey);
      const model = anthropicModel(info.data);
      // GET /models/{id} can resolve an alias; keep the caller's immutable model identity.
      const configuration = resolveAiConfiguration(requested.data, {
        ...model.descriptor,
        id: requested.data.modelId,
      });
      if (!configuration) throw new Error("INVALID_ANTHROPIC_REQUEST");
      const { temperature, maxOutputTokens, reasoningEffort } = configuration.parameters;
      const result = await requestJson("messages", input, {
        model: configuration.modelId,
        system: MODEL_RESPONSE_INSTRUCTION,
        messages: [{ role: "user", content: JSON.stringify(context.data) }],
        max_tokens: maxOutputTokens ?? Math.min(4_096, info.data.max_tokens ?? 4_096),
        stream: false,
        ...(temperature === undefined ? {} : { temperature }),
        ...(reasoningEffort !== undefined || model.structuredOutput
          ? {
              output_config: {
                ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
                ...(model.structuredOutput
                  ? {
                      format: {
                        type: "json_schema",
                        schema: {
                          type: "object",
                          properties: {
                            move: { type: "string", enum: context.data.legalMoves },
                            commentary: { type: "string" },
                          },
                          required: ["move"],
                          additionalProperties: false,
                        },
                      },
                    }
                  : {}),
              },
            }
          : {}),
      });
      const telemetry: AiTelemetry = {
        latencyMs: now() - started,
        usage: null,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
      };
      if (!result.ok) return { ok: false, error: result.error, ...telemetry };
      const message = messageSchema.safeParse(result.value);
      if (!message.success) {
        return { ok: false, error: { kind: "provider_unavailable" }, ...telemetry };
      }
      telemetry.usage = normalizeUsage(message.data.usage);
      const output =
        message.data.stop_reason === "end_turn" && message.data.stop_details == null
          ? extractMove(message.data.content)
          : undefined;
      const normalized = normalizeMoveResponse(output, context.data, telemetry);
      if (normalized.ok) {
        rejectCredentialEcho(normalized.value.move, input.apiKey);
        rejectCredentialEcho(normalized.value.commentary, input.apiKey);
      }
      return normalized;
    },
  };
}

function validateInput(input: ListModelsInput): void {
  if (!sessionCredentialSchema.safeParse({ provider: "anthropic", apiKey: input.apiKey }).success) {
    throw new Error("INVALID_ANTHROPIC_REQUEST");
  }
}

function httpError(status: number): ProviderError {
  if (status === 401 || status === 403) return { kind: "provider_auth" };
  if (status === 402 || status === 429) return { kind: "provider_quota" };
  if (status === 408 || status === 504) return { kind: "provider_timeout" };
  return { kind: "provider_unavailable" };
}

function normalizeUsage(value: unknown): AiTelemetry["usage"] {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return null;
  const {
    input_tokens: uncachedInputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
  } = parsed.data;
  let inputTokens = uncachedInputTokens;
  if (cacheCreationTokens !== undefined || cacheReadTokens !== undefined) {
    // When caching is reported, input_tokens is only the uncached portion. Do not
    // undercount it or guess a missing component of the reported input breakdown.
    const counts = [uncachedInputTokens, cacheCreationTokens, cacheReadTokens];
    const total = counts.every((count) => count != null)
      ? counts.reduce((sum, count) => sum + count, 0)
      : null;
    inputTokens = total !== null && Number.isSafeInteger(total) ? total : null;
  }
  if (inputTokens === null && outputTokens === null) return null;
  // Anthropic reports no total; output_tokens already includes thinking tokens.
  return { inputTokens, outputTokens, totalTokens: null };
}

function extractMove(value: unknown): unknown {
  const parsed = contentSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function rejectCredentialEcho(value: unknown, apiKey: string): void {
  if (typeof value === "string" && value.includes(apiKey)) {
    throw new Error("INVALID_ANTHROPIC_RESPONSE");
  }
}
