import type { ProviderFailure } from "@neurochess/contracts";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const timeoutCauseSchema = z.object({
  cause: z.object({
    code: z.enum(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]),
  }),
});

export type ProviderJsonResult =
  { ok: true; value: unknown } | { ok: false; error: ProviderFailure };

export function cancellationFailure(signal: AbortSignal): ProviderFailure {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? { code: "provider_timeout" }
    : { code: "provider_unavailable", reason: "cancelled" };
}

export function transportFailure(error: unknown, signal: AbortSignal): ProviderFailure {
  if (signal.aborted) return cancellationFailure(signal);
  if (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    timeoutCauseSchema.safeParse(error).success
  ) {
    return { code: "provider_timeout" };
  }
  return { code: "provider_unavailable", reason: "network" };
}

export async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<ProviderJsonResult> {
  const invalid: ProviderJsonResult = {
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
