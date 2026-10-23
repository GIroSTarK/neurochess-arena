import { performance } from "node:perf_hooks";

import {
  aiParametersSchema,
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
  googleCapabilities,
  googleModelIdSchema,
  googleModelSchema,
  unknownGoogleCapabilities,
} from "./google-capabilities.js";
import { googleRequest } from "./google-http.js";
import { parseMoveOutput, sanitizeMoveOutput } from "./move-output.js";

// Protobuf JSON can omit an empty repeated models field.
const modelsSchema = z.strictObject({
  models: z.array(googleModelSchema).max(1000).default([]),
  nextPageToken: z
    .string()
    .max(2048)
    .regex(/^[\x21-\x7e]*(?![\s\S])/)
    .optional(),
});
const partSchema = z
  .object({
    text: z.string().max(64_000).optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().max(64_000).optional(),
    inlineData: z.never().optional(),
    fileData: z.never().optional(),
    functionCall: z.never().optional(),
    functionResponse: z.never().optional(),
    executableCode: z.never().optional(),
    codeExecutionResult: z.never().optional(),
  })
  .refine((part) => part.text !== undefined || part.thoughtSignature !== undefined);
const count = z.number().int().nonnegative().nullish();
const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        index: z.literal(0).optional(),
        content: z
          .object({
            role: z.literal("model").optional(),
            parts: z.array(partSchema).max(128).optional(),
          })
          .optional(),
        finishReason: z.string().min(1).max(128),
      }),
    )
    .max(1)
    .optional(),
  promptFeedback: z
    .object({
      blockReason: z
        .enum([
          "BLOCK_REASON_UNSPECIFIED",
          "SAFETY",
          "OTHER",
          "BLOCKLIST",
          "PROHIBITED_CONTENT",
          "IMAGE_SAFETY",
        ])
        .optional(),
    })
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: count,
      candidatesTokenCount: count,
      totalTokenCount: count,
    })
    .nullish(),
});
const invalidResponse: ProviderFailure = {
  code: "provider_unavailable",
  reason: "invalid_response",
};

function extractMove(raw: unknown, input: MoveRequest, durationMs: number): NormalizedMoveResponse {
  const billing = normalizeBilling("google", input.modelId, raw);
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
    response.usageMetadata == null
      ? null
      : {
          inputTokens: response.usageMetadata.promptTokenCount ?? null,
          outputTokens: response.usageMetadata.candidatesTokenCount ?? null,
          // Google's reported total can include thoughts; never derive it from the other counts.
          totalTokens: response.usageMetadata.totalTokenCount ?? null,
        };
  const candidate = response.candidates?.[0];
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason !== undefined && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
    return candidate === undefined
      ? failure({ code: "model_invalid", reason: "refusal" }, usage)
      : failure(invalidResponse, usage);
  }
  if (candidate === undefined) return failure(invalidResponse, usage);
  switch (candidate.finishReason) {
    case "MAX_TOKENS":
      return failure({ code: "model_invalid", reason: "truncated_output" }, usage);
    case "SAFETY":
    case "RECITATION":
    case "LANGUAGE":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
    case "IMAGE_PROHIBITED_CONTENT":
    case "IMAGE_RECITATION":
    case "ESCALATION":
      return failure({ code: "model_invalid", reason: "refusal" }, usage);
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
    case "MALFORMED_RESPONSE":
      return failure({ code: "model_invalid", reason: "malformed_output" }, usage);
    case "STOP":
      break;
    default:
      return failure(invalidResponse, usage);
  }
  if (candidate.content?.parts === undefined) return failure(invalidResponse, usage);
  const text = candidate.content.parts
    .flatMap((part) => (part.thought === true || part.text === undefined ? [] : [part.text]))
    .join("");
  const output = parseMoveOutput(text);
  if (output === null) return failure({ code: "model_invalid", reason: "malformed_output" }, usage);
  return {
    ok: true,
    output: sanitizeMoveOutput(output, input.apiKey),
    usage,
    durationMs,
    billing,
    providerRequestId: null,
  };
}

export function createGoogleAdapter(transport: typeof fetch = fetch): AiProviderAdapter {
  return {
    provider: "google",
    async listModels(input): Promise<ModelDiscoveryResult> {
      const models: ModelDescriptor[] = [];
      const ids = new Set<string>();
      const tokens = new Set<string>();
      let pageToken: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const response = await googleRequest(
          transport,
          input,
          pageToken === undefined ? {} : { pageToken },
        );
        if (!response.ok) return response;
        const parsed = modelsSchema.safeParse(response.value);
        if (!parsed.success) return { ok: false, error: invalidResponse };
        const catalog = parsed.data;
        for (const model of catalog.models) {
          const name = model.displayName ?? model.name;
          if (
            ids.has(model.name) ||
            (input.apiKey.length > 0 &&
              (model.name.includes(input.apiKey) || name.includes(input.apiKey)))
          ) {
            return { ok: false, error: invalidResponse };
          }
          ids.add(model.name);
          models.push({
            provider: "google",
            id: model.name,
            name,
            capabilities: googleCapabilities(model),
          });
        }
        if (models.length > 10_000) return { ok: false, error: invalidResponse };
        const next = catalog.nextPageToken;
        if (next === undefined || next === "") {
          const result = modelDiscoveryResultSchema.safeParse({ ok: true, models });
          return result.success ? result.data : { ok: false, error: invalidResponse };
        }
        if (
          catalog.models.length === 0 ||
          models.length === 10_000 ||
          tokens.has(next) ||
          (input.apiKey.length > 0 && next.includes(input.apiKey))
        ) {
          return { ok: false, error: invalidResponse };
        }
        tokens.add(next);
        pageToken = next;
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
        !googleModelIdSchema.safeParse(input.modelId).success ||
        (input.apiKey.length > 0 && input.modelId.includes(input.apiKey))
      ) {
        return failure(invalidResponse);
      }
      const capabilities = input.capabilities ?? unknownGoogleCapabilities;
      if (capabilities.moveGeneration === "unsupported") {
        return failure({ code: "provider_unavailable", reason: "unsupported_model" });
      }
      if (!aiParametersSchema.safeParse(input.parameters).success) return failure(invalidResponse);
      const parameters = effectiveParameters(input.parameters, capabilities);
      if (parameters === null) return failure({ code: "provider_unavailable", reason: "upstream" });
      const { fen, pgn, color, turn, legalMoves } = input.context;
      const generationConfig = {
        ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
        ...(parameters.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: parameters.maxOutputTokens }),
      };
      const response = await googleRequest(transport, input, {
        modelId: input.modelId,
        body: {
          systemInstruction: { parts: [{ text: input.instructions }] },
          contents: [
            {
              role: "user",
              parts: [{ text: JSON.stringify({ fen, pgn, color, turn, legalMoves }) }],
            },
          ],
          store: false,
          ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
        },
      });
      return response.ok ? extractMove(response.value, input, duration()) : failure(response.error);
    },
  };
}
