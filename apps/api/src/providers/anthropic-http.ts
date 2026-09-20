import type { ProviderFailure } from "@neurochess/contracts";
import { z } from "zod";

import type { ListModelsInput } from "./adapter.js";
import { cancellationFailure } from "./invoke-move.js";

const errorSchema = z.object({
  type: z.literal("error"),
  error: z.object({ type: z.string().min(1).max(128) }),
});
const timeoutCauseSchema = z.object({
  cause: z.object({
    code: z.enum(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]),
  }),
});
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
type JsonResult = { ok: true; value: unknown } | { ok: false; error: ProviderFailure };

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

function httpFailure(status: number, path: "models" | "messages", type?: string): ProviderFailure {
  if (
    status === 401 ||
    status === 403 ||
    type === "authentication_error" ||
    type === "permission_error"
  ) {
    return { code: "provider_auth" };
  }
  if (status === 402 || status === 429 || type === "billing_error" || type === "rate_limit_error") {
    return { code: "provider_quota" };
  }
  if (status === 408 || status === 504 || type === "timeout_error") {
    return { code: "provider_timeout" };
  }
  if (path === "messages" && (status === 404 || type === "not_found_error")) {
    return { code: "provider_unavailable", reason: "unsupported_model" };
  }
  return { code: "provider_unavailable", reason: "upstream" };
}

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

export async function anthropicRequest(
  transport: typeof fetch,
  path: "models" | "messages",
  input: ListModelsInput,
  options: { body?: object; afterId?: string } = {},
): Promise<JsonResult> {
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const url = new URL(`https://api.anthropic.com/v1/${path}`);
  if (path === "models") {
    url.searchParams.set("limit", "1000");
    if (options.afterId !== undefined) url.searchParams.set("after_id", options.afterId);
  }
  let response: Response;
  try {
    // Pagination is explicit; individual HTTP calls never retry or follow redirects.
    response = await transport(url, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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
    const error = errorSchema.safeParse(result.ok ? result.value : null);
    if (response.ok && !error.success) return result;
    return { ok: false, error: httpFailure(response.status, path, error.data?.error.type) };
  } catch {
    return {
      ok: false,
      error: isAborted()
        ? cancellationFailure(input.signal)
        : response.ok
          ? { code: "provider_unavailable", reason: "invalid_response" }
          : httpFailure(response.status, path),
    };
  }
}
