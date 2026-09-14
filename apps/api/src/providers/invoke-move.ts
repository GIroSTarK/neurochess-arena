import { performance } from "node:perf_hooks";

import {
  type NormalizedMoveResponse,
  normalizedMoveResponseSchema,
  type ProviderFailure,
  type TokenUsage,
} from "@neurochess/contracts";
import { z } from "zod";

import type { AiProviderAdapter, MoveRequest } from "./adapter.js";

const outputEnvelopeSchema = normalizedMoveResponseSchema.options[0].extend({
  output: z.unknown(),
});

export function cancellationFailure(signal: AbortSignal): ProviderFailure {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? { code: "provider_timeout" }
    : { code: "provider_unavailable", reason: "cancelled" };
}

export async function invokeMove(
  adapter: AiProviderAdapter,
  input: MoveRequest,
): Promise<NormalizedMoveResponse> {
  const started = performance.now();
  const duration = () => Math.max(0, Math.round(performance.now() - started));
  const failure = (
    error: ProviderFailure,
    usage: TokenUsage | null = null,
  ): NormalizedMoveResponse => ({
    ok: false,
    error,
    durationMs: duration(),
    usage,
    providerRequestId: null,
  });
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return failure(cancellationFailure(input.signal));
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(new Error("AI request cancelled"));
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const raw: unknown = await Promise.race([
      Promise.resolve().then(() => {
        if (input.signal.aborted) throw new Error("AI request cancelled");
        return adapter.requestMove(input);
      }),
      cancelled.promise,
    ]);
    const parsed = normalizedMoveResponseSchema.safeParse(raw);
    if (parsed.success) {
      const response = parsed.data;
      if (response.ok) {
        const commentary = response.output.commentary;
        if (
          commentary !== undefined &&
          (commentary.includes("\0") ||
            (input.apiKey.length > 0 && commentary.includes(input.apiKey)))
        ) {
          // Optional viewer text must not persist a credential echo or a PostgreSQL-incompatible NUL.
          return {
            ...response,
            output: { move: response.output.move },
            durationMs: duration(),
            providerRequestId: null,
          };
        }
      }
      return { ...response, durationMs: duration(), providerRequestId: null };
    }
    const envelope = outputEnvelopeSchema.safeParse(raw);
    return envelope.success
      ? failure({ code: "model_invalid", reason: "malformed_output" }, envelope.data.usage)
      : failure({ code: "provider_unavailable", reason: "invalid_response" });
  } catch {
    // Never forward exception text, request objects, or AbortSignal.reason.
    return failure(
      input.signal.aborted
        ? cancellationFailure(input.signal)
        : { code: "provider_unavailable", reason: "upstream" },
    );
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
}
