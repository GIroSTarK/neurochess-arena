import {
  aiConfigurationSchema,
  type AiTelemetry,
  modelContextSchema,
  type ModelDescriptor,
  modelListSchema,
  type ProviderError,
  sessionCredentialSchema,
} from "@neurochess/contracts";
import { z } from "zod";

import type { AiProviderAdapter, ListModelsInput } from "./adapter.js";
import { MODEL_RESPONSE_INSTRUCTION } from "./context.js";
import { googleModel, googleModelNameSchema, googleModelSchema } from "./google-models.js";
import { normalizeMoveResponse, resolveAiConfiguration } from "./normalization.js";

const modelsSchema = z.object({
  models: z.array(googleModelSchema).max(1_000).default([]),
  nextPageToken: z
    .string()
    .max(4_096)
    .regex(/^[\x21-\x7e]*(?![\s\S])/)
    .optional(),
  error: z.never().optional(),
});
const responseSchema = z
  .object({
    candidates: z.array(z.unknown()).max(8).optional(),
    promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
    usageMetadata: z.unknown().optional(),
    responseId: z.unknown().optional(),
    modelVersion: z.string().optional(),
    error: z.never().optional(),
  })
  .refine((value) =>
    ["candidates", "promptFeedback", "usageMetadata", "modelVersion"].some((key) => key in value),
  );
const candidateSchema = z.object({
  finishReason: z.literal("STOP"),
  content: z.object({
    role: z.literal("model").optional(),
    parts: z.array(
      z.object({
        text: z.string(),
        thought: z.boolean().optional(),
        // A text field alongside tool or media data must not disguise unusable output.
        inlineData: z.never().optional(),
        fileData: z.never().optional(),
        functionCall: z.never().optional(),
        functionResponse: z.never().optional(),
        executableCode: z.never().optional(),
        codeExecutionResult: z.never().optional(),
        toolCall: z.never().optional(),
        toolResponse: z.never().optional(),
      }),
    ),
  }),
});
const tokenCount = z.number().int().nonnegative().nullable().catch(null);
const usageSchema = z.object({
  promptTokenCount: tokenCount,
  candidatesTokenCount: tokenCount,
  totalTokenCount: tokenCount,
});
const responseIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+(?![\s\S])/);
const authErrorSchema = z.object({
  error: z.object({
    details: z.array(z.unknown()).max(100),
  }),
});
const authDetailSchema = z.object({
  "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
  domain: z.literal("googleapis.com"),
  reason: z.enum(["API_KEY_INVALID", "API_KEY_SERVICE_BLOCKED"]),
});

type JsonResult = { ok: true; value: unknown } | { ok: false; error: ProviderError };

export function createGoogleProvider(
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
    throw new Error("INVALID_GOOGLE_TIMEOUT");
  }

  async function requestJson(
    path: string,
    input: ListModelsInput,
    body?: object,
  ): Promise<JsonResult> {
    const timeout = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const headers = new Headers({ Accept: "application/json", "x-goog-api-key": input.apiKey });
    try {
      signal.throwIfAborted();
      if (body) headers.set("Content-Type", "application/json");
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: "error",
      });
      signal.throwIfAborted();
      if (!response.ok) {
        let error = httpError(response.status);
        if (response.status === 400) {
          // Google also reports invalid keys as 400. Inspect only typed ErrorInfo;
          // messages, metadata, and other upstream diagnostics never leave this scope.
          const value: unknown = await response.json().catch(() => null);
          const parsed = authErrorSchema.safeParse(value);
          if (
            parsed.success &&
            parsed.data.error.details.some((detail) => authDetailSchema.safeParse(detail).success)
          ) {
            error = { kind: "provider_auth" };
          }
        } else {
          await response.body?.cancel();
        }
        signal.throwIfAborted();
        return { ok: false, error };
      }
      const value: unknown = await response.json();
      signal.throwIfAborted();
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
      headers.delete("x-goog-api-key");
    }
  }

  return {
    get descriptor() {
      return { id: "google" as const, name: "Google" };
    },
    async listModels(input) {
      validateInput(input);
      const models: ModelDescriptor[] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await requestJson(
          `models?pageSize=1000${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`,
          input,
        );
        if (!result.ok) return result;
        const parsed = modelsSchema.safeParse(result.value);
        if (!parsed.success || ids.size + parsed.data.models.length > 2_000) {
          throw new Error("INVALID_GOOGLE_RESPONSE");
        }
        for (const info of parsed.data.models) {
          rejectCredentialEcho(info.name, input.apiKey);
          rejectCredentialEcho(info.displayName, input.apiKey);
          if (ids.has(info.name)) throw new Error("INVALID_GOOGLE_RESPONSE");
          ids.add(info.name);
          const model = googleModel(info);
          if (model) models.push(model.descriptor);
        }
        cursor = parsed.data.nextPageToken;
        if (!cursor) return { ok: true, value: modelListSchema.parse(models) };
        rejectCredentialEcho(cursor, input.apiKey);
        if (cursors.has(cursor) || ids.size === 2_000) throw new Error("INVALID_GOOGLE_RESPONSE");
        cursors.add(cursor);
      }
      throw new Error("INVALID_GOOGLE_RESPONSE");
    },
    async requestMove(input) {
      validateInput(input);
      const requested = aiConfigurationSchema.safeParse(input.configuration);
      const context = modelContextSchema.safeParse(input.context);
      if (
        !requested.success ||
        requested.data.provider !== "google" ||
        !googleModelNameSchema.safeParse(requested.data.modelId).success ||
        requested.data.modelId.includes(input.apiKey) ||
        !context.success
      ) {
        throw new Error("INVALID_GOOGLE_REQUEST");
      }
      const started = now();
      const failure = (error: ProviderError) => ({
        ok: false as const,
        error,
        latencyMs: now() - started,
        usage: null,
      });
      // Refresh with this operation's key so persisted games need no warm catalog.
      const metadata = await requestJson(requested.data.modelId, input);
      if (!metadata.ok) return failure(metadata.error);
      const info = googleModelSchema.safeParse(metadata.value);
      if (!info.success || info.data.name !== requested.data.modelId) {
        return failure({ kind: "provider_unavailable" });
      }
      const model = googleModel(info.data);
      if (!model) return failure({ kind: "provider_unavailable" });
      const configuration = resolveAiConfiguration(requested.data, model.descriptor);
      if (!configuration) throw new Error("INVALID_GOOGLE_REQUEST");
      const { temperature, maxOutputTokens, reasoningEffort } = configuration.parameters;
      const result = await requestJson(`${configuration.modelId}:generateContent`, input, {
        contents: [
          {
            role: "user",
            // A user text instruction also works for models without systemInstruction support.
            parts: [{ text: MODEL_RESPONSE_INSTRUCTION }, { text: JSON.stringify(context.data) }],
          },
        ],
        generationConfig: {
          ...(temperature === undefined ? {} : { temperature }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          ...(reasoningEffort === undefined
            ? {}
            : { thinkingConfig: { thinkingLevel: reasoningEffort } }),
          ...(model.structuredOutput
            ? {
                responseFormat: {
                  text: {
                    mimeType: "application/json",
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
                },
              }
            : {}),
        },
      });
      if (!result.ok) return failure(result.error);
      const response = responseSchema.safeParse(result.value);
      if (!response.success) return failure({ kind: "provider_unavailable" });
      rejectCredentialEcho(response.data.responseId, input.apiKey);
      const id = responseIdSchema.safeParse(response.data.responseId);
      const telemetry: AiTelemetry = {
        latencyMs: now() - started,
        usage: normalizeUsage(response.data.usageMetadata),
        ...(id.success ? { providerRequestId: id.data } : {}),
      };
      const block = response.data.promptFeedback?.blockReason;
      const candidates = response.data.candidates;
      const output =
        (!block || block === "BLOCK_REASON_UNSPECIFIED") && candidates?.length === 1
          ? extractMove(candidates[0])
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
  if (!sessionCredentialSchema.safeParse({ provider: "google", apiKey: input.apiKey }).success) {
    throw new Error("INVALID_GOOGLE_REQUEST");
  }
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
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: totalTokens,
  } = parsed.data;
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  // Prompt includes cached input; total includes thoughts. Preserve reported counts
  // independently instead of inferring missing counts or double-counting breakdowns.
  return { inputTokens, outputTokens, totalTokens };
}

function extractMove(value: unknown): unknown {
  const parsed = candidateSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data.content.parts
    .filter((part) => !part.thought)
    .map((part) => part.text)
    .join("");
}

function rejectCredentialEcho(value: unknown, apiKey: string): void {
  if (typeof value === "string" && value.includes(apiKey)) {
    throw new Error("INVALID_GOOGLE_RESPONSE");
  }
}
