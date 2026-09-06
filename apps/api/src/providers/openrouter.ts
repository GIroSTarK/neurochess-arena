import {
  aiConfigurationSchema,
  type AiTelemetry,
  modelContextSchema,
  modelListSchema,
  type ProviderError,
  sessionCredentialSchema,
} from "@neurochess/contracts";
import { z } from "zod";

import type { AiProviderAdapter, ListModelsInput } from "./adapter.js";
import { MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { normalizeMoveResponse, resolveAiConfiguration } from "./normalization.js";
import {
  openRouterModel,
  openRouterModelIdSchema,
  openRouterModelSchema,
} from "./openrouter-models.js";

const modelsSchema = z.object({ data: z.array(openRouterModelSchema).max(2_000) });
const modelSchema = z.object({ data: openRouterModelSchema });
const responseSchema = z.object({ choices: z.array(z.unknown()).max(8) });
const errorEnvelopeSchema = z.object({ error: z.unknown() });
const errorSchema = z.object({
  code: z.number().int().optional().catch(undefined),
  metadata: z.object({ error_type: z.string().optional() }).nullish().catch(undefined),
});
const choiceSchema = z.object({
  finish_reason: z.literal("stop"),
  message: z.object({
    role: z.literal("assistant"),
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.literal("text"), text: z.string() })),
    ]),
    refusal: z.null().optional(),
    tool_calls: z.array(z.never()).max(0).nullish(),
    function_call: z.null().optional(),
    images: z.array(z.never()).max(0).nullish(),
    audio: z.null().optional(),
  }),
});
const choiceErrorSchema = z.object({
  finish_reason: z.string().optional(),
  error: z.unknown().optional(),
});
const tokenCount = z.number().int().nonnegative().nullable().catch(null);
const usageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  total_tokens: tokenCount,
});
const telemetrySchema = z.object({ id: z.unknown().optional(), usage: z.unknown().optional() });
const responseIdSchema = z
  .string()
  .max(200)
  .regex(/^(?:gen-|chatcmpl-)[a-zA-Z0-9_-]+(?![\s\S])/);

type JsonResult =
  { ok: true; value: unknown } | { ok: false; error: ProviderError; value?: unknown };

export function createOpenRouterProvider(
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
    throw new Error("INVALID_OPENROUTER_TIMEOUT");
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
      Authorization: `Bearer ${input.apiKey}`,
    });
    try {
      signal.throwIfAborted();
      if (body) headers.set("Content-Type", "application/json");
      const response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: "error",
      });
      signal.throwIfAborted();
      const value: unknown = await response.json().catch((error: unknown) => {
        if (response.ok || (error instanceof Error && error.name === "TimeoutError")) throw error;
        return null;
      });
      signal.throwIfAborted();
      const envelope = errorEnvelopeSchema.safeParse(value);
      if (!response.ok || (envelope.success && envelope.data.error != null)) {
        return {
          ok: false,
          error: providerError(envelope.success ? envelope.data.error : undefined, response.status),
          value,
        };
      }
      return { ok: true, value };
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
      headers.delete("Authorization");
    }
  }

  return {
    get descriptor() {
      return { id: "openrouter" as const, name: "OpenRouter" };
    },
    async listModels(input) {
      validateInput(input);
      // Omitting pagination returns the complete live catalog, bounded by our shared contract.
      const result = await requestJson("models", input);
      if (!result.ok) return { ok: false, error: result.error };
      const parsed = modelsSchema.safeParse(result.value);
      if (!parsed.success) throw new Error("INVALID_OPENROUTER_RESPONSE");
      const ids = new Set<string>();
      const models = [];
      for (const info of parsed.data.data) {
        rejectCredentialEcho(info.id, input.apiKey);
        rejectCredentialEcho(info.name, input.apiKey);
        if (ids.has(info.id)) throw new Error("INVALID_OPENROUTER_RESPONSE");
        ids.add(info.id);
        const model = openRouterModel(info);
        if (model) {
          for (const effort of model.descriptor.supportedParameters.reasoningEffort?.values ?? []) {
            rejectCredentialEcho(effort, input.apiKey);
          }
          models.push(model.descriptor);
        }
      }
      return { ok: true, value: modelListSchema.parse(models) };
    },
    async requestMove(input) {
      validateInput(input);
      const requested = aiConfigurationSchema.safeParse(input.configuration);
      const context = modelContextSchema.safeParse(input.context);
      if (
        !requested.success ||
        requested.data.provider !== "openrouter" ||
        !context.success ||
        !openRouterModelIdSchema.safeParse(requested.data.modelId).success ||
        requested.data.modelId.includes(input.apiKey)
      ) {
        throw new Error("INVALID_OPENROUTER_REQUEST");
      }
      const started = now();
      const failure = (error: ProviderError) => ({
        ok: false as const,
        error,
        latencyMs: now() - started,
        usage: null,
      });
      // A persisted seat can execute after restart without a warm discovery cache.
      const path = requested.data.modelId.split("/").map(encodeURIComponent).join("/");
      const metadata = await requestJson(`model/${path}`, input);
      if (!metadata.ok) return failure(metadata.error);
      const info = modelSchema.safeParse(metadata.value);
      if (!info.success) return failure({ kind: "provider_unavailable" });
      const model = openRouterModel(info.data.data);
      if (!model) return failure({ kind: "provider_unavailable" });
      // The metadata endpoint resolves aliases; the selected ID and variant remain immutable.
      const configuration = resolveAiConfiguration(requested.data, {
        ...model.descriptor,
        id: requested.data.modelId,
      });
      if (!configuration) throw new Error("INVALID_OPENROUTER_REQUEST");
      const { temperature, maxOutputTokens, reasoningEffort } = configuration.parameters;
      const result = await requestJson("chat/completions", input, {
        model: configuration.modelId,
        messages: [
          {
            role: "user",
            content: `${MODEL_RESPONSE_INSTRUCTION}\n\n${JSON.stringify(context.data)}`,
          },
        ],
        stream: false,
        provider: { require_parameters: true, allow_fallbacks: false },
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxOutputTokens === undefined ? {} : { [model.outputTokenParameter]: maxOutputTokens }),
        ...(reasoningEffort === undefined ? {} : { reasoning: { effort: reasoningEffort } }),
        ...(model.responseFormat === undefined
          ? {}
          : {
              response_format:
                model.responseFormat === "json_object"
                  ? { type: "json_object" }
                  : {
                      type: "json_schema",
                      json_schema: {
                        name: "chess_move",
                        strict: true,
                        schema: {
                          type: "object",
                          properties: {
                            move: { type: "string", enum: context.data.legalMoves },
                            commentary: { type: ["string", "null"] },
                          },
                          required: ["move", "commentary"],
                          additionalProperties: false,
                        },
                      },
                    },
            }),
      });
      const fields = telemetrySchema.safeParse(result.value);
      const id = responseIdSchema.safeParse(fields.success ? fields.data.id : undefined);
      if (fields.success) rejectCredentialEcho(fields.data.id, input.apiKey);
      const telemetry: AiTelemetry = {
        latencyMs: now() - started,
        usage: normalizeUsage(fields.success ? fields.data.usage : undefined),
        ...(id.success ? { providerRequestId: id.data } : {}),
      };
      if (!result.ok) return { ok: false, error: result.error, ...telemetry };
      const response = responseSchema.safeParse(result.value);
      if (!response.success) {
        return { ok: false, error: { kind: "provider_unavailable" }, ...telemetry };
      }
      for (const choice of response.data.choices) {
        const error = choiceErrorSchema.safeParse(choice);
        if (error.success && (error.data.error != null || error.data.finish_reason === "error")) {
          return { ok: false, error: providerError(error.data.error), ...telemetry };
        }
      }
      const output =
        response.data.choices.length === 1 ? extractMove(response.data.choices[0]) : undefined;
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
  if (
    !sessionCredentialSchema.safeParse({ provider: "openrouter", apiKey: input.apiKey }).success
  ) {
    throw new Error("INVALID_OPENROUTER_REQUEST");
  }
}

function providerError(value: unknown, status?: number): ProviderError {
  const parsed = errorSchema.safeParse(value);
  if (parsed.success) {
    const kind = parsed.data.metadata?.error_type;
    if (kind === "authentication" || kind === "permission_denied") return { kind: "provider_auth" };
    if (
      kind === "payment_required" ||
      kind === "rate_limit_exceeded" ||
      kind === "token_limit_exceeded"
    ) {
      return { kind: "provider_quota" };
    }
    if (kind === "timeout") return { kind: "provider_timeout" };
    status = parsed.data.code ?? status;
  }
  if (status === 401 || status === 403) return { kind: "provider_auth" };
  if (status === 402 || status === 429) return { kind: "provider_quota" };
  if (status === 408 || status === 504) return { kind: "provider_timeout" };
  return { kind: "provider_unavailable" };
}

function normalizeUsage(value: unknown): AiTelemetry["usage"] {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return null;
  const {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
  } = parsed.data;
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  // Cached and reasoning tokens are already included; never add breakdowns or infer totals.
  return { inputTokens, outputTokens, totalTokens };
}

function extractMove(value: unknown): unknown {
  const parsed = choiceSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const content = parsed.data.message.content;
  const text = typeof content === "string" ? content : content.map((part) => part.text).join("");
  try {
    const output: unknown = JSON.parse(text);
    // Strict routed schemas require every property; null commentary represents absence.
    if (
      output &&
      typeof output === "object" &&
      "commentary" in output &&
      output.commentary === null
    ) {
      delete output.commentary;
    }
    return output;
  } catch {
    return undefined;
  }
}

function rejectCredentialEcho(value: unknown, apiKey: string): void {
  if (typeof value === "string" && value.includes(apiKey)) {
    throw new Error("INVALID_OPENROUTER_RESPONSE");
  }
}
