import {
  aiConfigurationSchema,
  type AiTelemetry,
  modelContextSchema,
  modelIdSchema,
  modelListSchema,
  type ProviderError,
  sessionCredentialSchema,
} from "@neurochess/contracts";
import { z } from "zod";

import type { AiProviderAdapter, ListModelsInput } from "./adapter.js";
import { MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { normalizeMoveResponse, resolveAiConfiguration } from "./normalization.js";
import { openAiModel } from "./openai-models.js";

const modelsSchema = z.object({
  object: z.literal("list"),
  data: z
    .array(
      z.object({
        id: modelIdSchema,
        object: z.literal("model"),
        created: z.number().int().nonnegative(),
        owned_by: z.string(),
      }),
    )
    .max(2_000),
});
const responseSchema = z.object({
  object: z.literal("response"),
  id: z.unknown().optional(),
  status: z.enum(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]),
  error: z.unknown().optional(),
  output: z.unknown().optional(),
  usage: z.unknown().optional(),
});
const outputSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("reasoning") }),
    z.object({
      type: z.literal("message"),
      role: z.literal("assistant"),
      status: z.literal("completed"),
      content: z.array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("output_text"), text: z.string() }),
          z.object({ type: z.literal("refusal") }),
        ]),
      ),
    }),
  ]),
);
const tokenCount = z.number().int().nonnegative().nullable().catch(null);
const usageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  total_tokens: tokenCount,
});
const responseIdSchema = z
  .string()
  .max(200)
  .regex(/^resp_[a-zA-Z0-9_-]+(?![\s\S])/);
const responseErrorSchema = z.object({ code: z.string() });

type JsonResult =
  | { ok: true; value: unknown; latencyMs: number }
  | { ok: false; error: ProviderError; latencyMs: number };

export function createOpenAiProvider(
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
    throw new Error("INVALID_OPENAI_TIMEOUT");
  }

  async function requestJson(
    path: "models" | "responses",
    input: ListModelsInput,
    body?: object,
  ): Promise<JsonResult> {
    if (!sessionCredentialSchema.safeParse({ provider: "openai", apiKey: input.apiKey }).success) {
      throw new Error("INVALID_OPENAI_REQUEST");
    }
    const started = now();
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
      const response = await fetch(`https://api.openai.com/v1/${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: "error",
      });
      signal.throwIfAborted();
      if (!response.ok) {
        // HTTP status is sufficient for our taxonomy; never read a secret-bearing error message.
        await response.body?.cancel();
        return { ok: false, error: httpError(response.status), latencyMs: now() - started };
      }
      const value: unknown = await response.json();
      signal.throwIfAborted();
      return { ok: true, value, latencyMs: now() - started };
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          kind:
            timeout.signal.aborted || (error instanceof Error && error.name === "TimeoutError")
              ? "provider_timeout"
              : "provider_unavailable",
        },
        latencyMs: now() - started,
      };
    } finally {
      clearTimeout(timer);
      headers.delete("Authorization");
    }
  }

  return {
    get descriptor() {
      return { id: "openai" as const, name: "OpenAI" };
    },
    async listModels(input) {
      const result = await requestJson("models", input);
      if (!result.ok) return { ok: false, error: result.error };
      const parsed = modelsSchema.safeParse(result.value);
      if (!parsed.success) throw new Error("INVALID_OPENAI_RESPONSE");
      const models = parsed.data.data.map(({ id }) => {
        rejectCredentialEcho(id, input.apiKey);
        return openAiModel(id).descriptor;
      });
      const catalog = modelListSchema.safeParse(models);
      if (!catalog.success) throw new Error("INVALID_OPENAI_RESPONSE");
      return { ok: true, value: catalog.data };
    },
    async requestMove(input) {
      const requested = aiConfigurationSchema.safeParse(input.configuration);
      const context = modelContextSchema.safeParse(input.context);
      if (!requested.success || !context.success) throw new Error("INVALID_OPENAI_REQUEST");
      const model = openAiModel(requested.data.modelId);
      const configuration = resolveAiConfiguration(requested.data, model.descriptor);
      if (!configuration) throw new Error("INVALID_OPENAI_REQUEST");
      const { temperature, maxOutputTokens, reasoningEffort } = configuration.parameters;
      const result = await requestJson("responses", input, {
        model: configuration.modelId,
        instructions: MODEL_RESPONSE_INSTRUCTION,
        input: [{ role: "user", content: JSON.stringify(context.data) }],
        store: false,
        stream: false,
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
        ...(reasoningEffort === undefined ? {} : { reasoning: { effort: reasoningEffort } }),
        ...(model.structuredOutput
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "chess_move",
                  strict: true,
                  schema: {
                    type: "object",
                    properties: {
                      move: { type: "string", enum: context.data.legalMoves },
                      commentary: { type: ["string", "null"], maxLength: 2_000 },
                    },
                    required: ["move", "commentary"],
                    additionalProperties: false,
                  },
                },
              },
            }
          : {}),
      });
      if (!result.ok) return { ...result, usage: null };
      const parsed = responseSchema.safeParse(result.value);
      if (!parsed.success) {
        return {
          ok: false,
          error: { kind: "provider_unavailable" },
          latencyMs: result.latencyMs,
          usage: null,
        };
      }
      const response = parsed.data;
      rejectCredentialEcho(response.id, input.apiKey);
      const id = responseIdSchema.safeParse(response.id);
      const telemetry: AiTelemetry = {
        latencyMs: result.latencyMs,
        usage: normalizeUsage(response.usage),
        ...(id.success ? { providerRequestId: id.data } : {}),
      };
      if (response.error != null || !["completed", "incomplete"].includes(response.status)) {
        const error = responseErrorSchema.safeParse(response.error);
        return {
          ok: false,
          error: {
            kind:
              error.success && error.data.code === "rate_limit_exceeded"
                ? "provider_quota"
                : "provider_unavailable",
          },
          ...telemetry,
        };
      }
      const output = response.status === "completed" ? extractMove(response.output) : undefined;
      const normalized = normalizeMoveResponse(output, context.data, telemetry);
      if (normalized.ok) {
        rejectCredentialEcho(normalized.value.move, input.apiKey);
        rejectCredentialEcho(normalized.value.commentary, input.apiKey);
      }
      return normalized;
    },
  };
}

function httpError(status: number): ProviderError {
  if (status === 401 || status === 403) return { kind: "provider_auth" };
  if (status === 429) return { kind: "provider_quota" };
  if (status === 408 || status === 504) return { kind: "provider_timeout" };
  return { kind: "provider_unavailable" };
}

function normalizeUsage(value: unknown): AiTelemetry["usage"] {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return null;
  const {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  } = parsed.data;
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function extractMove(value: unknown): unknown {
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  let text = "";
  for (const item of parsed.data) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "refusal") return undefined;
      text += content.text;
    }
  }
  try {
    const output: unknown = JSON.parse(text);
    // OpenAI strict schemas require every property; nullable commentary represents absence.
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
    throw new Error("INVALID_OPENAI_RESPONSE");
  }
}
