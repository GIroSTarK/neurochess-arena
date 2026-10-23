import type { ProviderFailure } from "@neurochess/contracts";
import { z } from "zod";

import type { ProviderRequestAccess } from "./adapter.js";
import { cancellationFailure } from "./invoke-move.js";

const errorSchema = z.object({
  error: z.object({ code: z.string().max(128).nullish(), param: z.string().max(128).nullish() }),
});
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const timeoutCauseSchema = z.object({
  cause: z.object({
    code: z.enum(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]),
  }),
});

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

export function openAiFailure(
  status: number,
  code?: string | null,
  param?: string | null,
): ProviderFailure {
  if (status === 401 || status === 403 || code === "invalid_api_key") {
    return { code: "provider_auth" };
  }
  if (
    status === 429 ||
    [
      "rate_limit_exceeded",
      "insufficient_quota",
      "credit_balance_exhausted",
      "slow_down",
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
      "organization_usage_limit_exceeded",
    ].includes(code ?? "")
  ) {
    return { code: "provider_quota" };
  }
  if (status === 408 || status === 504 || code === "request_timeout") {
    return { code: "provider_timeout" };
  }
  if (
    code === "model_not_found" ||
    code === "unsupported_model" ||
    (status === 400 && param === "model")
  ) {
    return { code: "provider_unavailable", reason: "unsupported_model" };
  }
  return { code: "provider_unavailable", reason: "upstream" };
}

type JsonResult = { ok: true; value: unknown } | { ok: false; error: ProviderFailure };

async function readJson(response: Response, signal: AbortSignal): Promise<JsonResult> {
  const invalid: JsonResult = {
    ok: false,
    error: { code: "provider_unavailable", reason: "invalid_response" },
  };
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
    const bytes = Buffer.concat(chunks);
    try {
      return {
        ok: true,
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      };
    } catch {
      return invalid;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function openAiRequest(
  transport: typeof fetch,
  path: "models" | "responses",
  input: ProviderRequestAccess,
  body?: object,
): Promise<JsonResult> {
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const denied = await input.beforeDispatch?.();
  if (denied) return { ok: false, error: denied };
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  let response: Response;
  try {
    // One fetch only: no retry/backoff, redirect, credential cache, or SDK state.
    response = await transport(`https://api.openai.com/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: input.signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
  } catch (error: unknown) {
    return {
      ok: false,
      error: transportFailure(error, input.signal),
    };
  }
  try {
    const result = await readJson(response, input.signal);
    if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
    if (response.ok) return result;
    const error = errorSchema.safeParse(result.ok ? result.value : null);
    return {
      ok: false,
      error: openAiFailure(response.status, error.data?.error.code, error.data?.error.param),
    };
  } catch {
    return {
      ok: false,
      error: isAborted()
        ? cancellationFailure(input.signal)
        : response.ok
          ? { code: "provider_unavailable", reason: "invalid_response" }
          : openAiFailure(response.status),
    };
  }
}
