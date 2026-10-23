import type { BillingUsage, ProviderFailure, TokenUsage } from "@neurochess/contracts";
import { z } from "zod";

import type { ProviderRequestAccess } from "./adapter.js";
import { normalizeBilling } from "./billing.js";
import { cancellationFailure } from "./invoke-move.js";

const errorSchema = z.object({
  error: z.object({
    code: z.number().int().min(400).max(599),
    metadata: z
      .object({
        error_type: z.string().min(1).max(128).nullish(),
        provider_name: z.string().min(1).max(256).nullish(),
        provider_code: z.string().max(128).nullish(),
      })
      .nullish(),
  }),
});
const timeoutCauseSchema = z.object({
  cause: z.object({
    code: z.enum(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]),
  }),
});
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const count = z.number().int().nonnegative().nullish();
export const openRouterUsageSchema = z
  .object({
    prompt_tokens: count,
    completion_tokens: count,
    total_tokens: count,
  })
  .nullish()
  .transform((usage): TokenUsage | null =>
    usage == null
      ? null
      : {
          inputTokens: usage.prompt_tokens ?? null,
          outputTokens: usage.completion_tokens ?? null,
          totalTokens: usage.total_tokens ?? null,
        },
  );
type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ProviderFailure; usage?: TokenUsage | null; billing?: BillingUsage };
type OpenRouterOperation = { body: object } | { offset: number };
const invalidResponse: ProviderFailure = {
  code: "provider_unavailable",
  reason: "invalid_response",
};

function transportFailure(error: unknown, signal: AbortSignal): ProviderFailure {
  if (signal.aborted) return cancellationFailure(signal);
  if (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    timeoutCauseSchema.safeParse(error).success
  ) {
    return { code: "provider_timeout" };
  }
  return { code: "provider_unavailable", reason: "network" };
}

function httpFailure(
  status: number,
  generation: boolean,
  error?: z.infer<typeof errorSchema>["error"],
): ProviderFailure {
  const type = error?.metadata?.error_type;
  const code = error?.code ?? status;
  // Typed router envelopes can wrap an upstream failure even under HTTP 200/502.
  switch (type) {
    case "refusal":
      if (generation) return { code: "model_invalid", reason: "refusal" };
      break;
    case "max_tokens_exceeded":
      if (generation) return { code: "model_invalid", reason: "truncated_output" };
      break;
    case "rate_limit_exceeded":
    case "payment_required":
    case "token_limit_exceeded":
      return { code: "provider_quota" };
    case "timeout":
      return { code: "provider_timeout" };
    case "not_found":
      if (generation) return { code: "provider_unavailable", reason: "unsupported_model" };
      break;
    case "provider_unavailable":
      return invalidResponse;
  }
  if (type != null) return { code: "provider_unavailable", reason: "upstream" };
  if (code === 401) {
    // An upstream credential failure does not mean the user's OpenRouter key is invalid.
    return error?.metadata?.provider_name != null ||
      error?.metadata?.provider_code != null ||
      status === 200
      ? { code: "provider_unavailable", reason: "upstream" }
      : { code: "provider_auth" };
  }
  if (code === 402 || code === 429) return { code: "provider_quota" };
  if (code === 408 || code === 504) return { code: "provider_timeout" };
  if (generation && code === 404) {
    return { code: "provider_unavailable", reason: "unsupported_model" };
  }
  // HTTP 403 also covers guardrails and external moderation; prose cannot establish a model refusal.
  return { code: "provider_unavailable", reason: "upstream" };
}

async function readJson(response: Response, signal: AbortSignal): Promise<JsonResult> {
  const invalid: JsonResult = { ok: false, error: invalidResponse };
  if (!response.body) return invalid;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error: unknown) {
        return { ok: false, error: transportFailure(error, signal) };
      }
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) return invalid;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return invalid;
      chunks.push(value);
    }
    try {
      return {
        ok: true,
        value: JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        ) as unknown,
      };
    } catch {
      return invalid;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function openRouterRequest(
  transport: typeof fetch,
  input: ProviderRequestAccess,
  operation: OpenRouterOperation,
): Promise<JsonResult> {
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const denied = await input.beforeDispatch?.();
  if (denied) return { ok: false, error: denied };
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const generation = "body" in operation;
  const url = new URL(
    `https://openrouter.ai/api/v1/${generation ? "chat/completions" : "models/user"}`,
  );
  if (!generation) {
    url.searchParams.set("offset", String(operation.offset));
    url.searchParams.set("limit", "1000");
  }
  let response: Response;
  try {
    response = await transport(url, {
      method: generation ? "POST" : "GET",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      ...(generation ? { body: JSON.stringify(operation.body) } : {}),
      signal: input.signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
  } catch (error: unknown) {
    return { ok: false, error: transportFailure(error, input.signal) };
  }
  try {
    const result = await readJson(response, input.signal);
    if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
    const raw = result.ok ? result.value : null;
    const hasError = typeof raw === "object" && raw !== null && "error" in raw;
    const error = errorSchema.safeParse(raw);
    if (response.ok && !hasError) return result;
    if (response.ok && !error.success) return { ok: false, error: invalidResponse };
    const usage = z.object({ usage: openRouterUsageSchema }).safeParse(raw);
    if (error.success && !usage.success) return { ok: false, error: invalidResponse };
    return {
      ok: false,
      error: httpFailure(response.status, generation, error.data?.error),
      usage: usage.data?.usage ?? null,
      ...(generation ? { billing: normalizeBilling("openrouter", "", raw) } : {}),
    };
  } catch {
    return {
      ok: false,
      error: isAborted()
        ? cancellationFailure(input.signal)
        : response.ok
          ? invalidResponse
          : httpFailure(response.status, generation),
    };
  }
}
