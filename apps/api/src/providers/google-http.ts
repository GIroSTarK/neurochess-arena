import type { ProviderFailure } from "@neurochess/contracts";
import { z } from "zod";

import type { ListModelsInput } from "./adapter.js";
import { cancellationFailure } from "./invoke-move.js";

const errorSchema = z.object({
  error: z.object({
    code: z.number().int().min(100).max(599),
    status: z.string().min(1).max(128),
    details: z.array(z.unknown()).max(32).optional(),
  }),
});
const invalidKeySchema = z.object({
  "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
  domain: z.literal("googleapis.com"),
  reason: z.literal("API_KEY_INVALID"),
});
const timeoutCauseSchema = z.object({
  cause: z.object({
    code: z.enum(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]),
  }),
});
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
type JsonResult = { ok: true; value: unknown } | { ok: false; error: ProviderFailure };
type GoogleOperation = { modelId: string; body: object } | { pageToken?: string };

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
  if (
    status === 401 ||
    status === 403 ||
    error?.status === "UNAUTHENTICATED" ||
    error?.status === "PERMISSION_DENIED" ||
    error?.details?.some((detail) => invalidKeySchema.safeParse(detail).success)
  ) {
    return { code: "provider_auth" };
  }
  if (status === 429 || error?.status === "RESOURCE_EXHAUSTED") return { code: "provider_quota" };
  if (status === 408 || status === 504 || error?.status === "DEADLINE_EXCEEDED") {
    return { code: "provider_timeout" };
  }
  if (status === 499 || error?.status === "CANCELLED") {
    return { code: "provider_unavailable", reason: "cancelled" };
  }
  if (
    generation &&
    (status === 404 ||
      status === 501 ||
      error?.status === "NOT_FOUND" ||
      error?.status === "UNIMPLEMENTED")
  ) {
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

export async function googleRequest(
  transport: typeof fetch,
  input: ListModelsInput,
  operation: GoogleOperation,
): Promise<JsonResult> {
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const generation = "modelId" in operation;
  const url = new URL(
    generation
      ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(operation.modelId)}:generateContent`
      : "https://generativelanguage.googleapis.com/v1beta/models",
  );
  if (!generation) {
    url.searchParams.set("pageSize", "1000");
    if (operation.pageToken !== undefined) url.searchParams.set("pageToken", operation.pageToken);
  }
  let response: Response;
  try {
    // Keys stay in headers; pagination never changes the origin, and calls never retry.
    response = await transport(url, {
      method: generation ? "POST" : "GET",
      headers: { "x-goog-api-key": input.apiKey, "Content-Type": "application/json" },
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
    const error = errorSchema.safeParse(result.ok ? result.value : null);
    if (response.ok && !error.success) return result;
    return { ok: false, error: httpFailure(response.status, generation, error.data?.error) };
  } catch {
    return {
      ok: false,
      error: isAborted()
        ? cancellationFailure(input.signal)
        : response.ok
          ? { code: "provider_unavailable", reason: "invalid_response" }
          : httpFailure(response.status, generation),
    };
  }
}
