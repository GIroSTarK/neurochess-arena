import { performance } from "node:perf_hooks";

import {
  type BillingUsage,
  type NormalizedMoveResponse,
  normalizedMoveResponseSchema,
  type ProviderFailure,
  type TokenUsage,
} from "@neurochess/contracts";
import { z } from "zod";

import { observeProvider, type Operations } from "../monitoring/operations.js";

import type { AiProviderAdapter, MoveRequest } from "./adapter.js";
import { sanitizeMoveOutput } from "./move-output.js";
import { cancellationFailure } from "./transport.js";

const outputEnvelopeSchema = normalizedMoveResponseSchema.options[0].extend({
  output: z.unknown(),
});

export function invokeMove(
  adapter: AiProviderAdapter,
  input: MoveRequest,
  operations?: Operations,
): Promise<NormalizedMoveResponse> {
  return observeProvider(operations, () => invokeMoveResult(adapter, input));
}

async function invokeMoveResult(
  adapter: AiProviderAdapter,
  input: MoveRequest,
): Promise<NormalizedMoveResponse> {
  const started = performance.now();
  const duration = () => Math.max(0, Math.round(performance.now() - started));
  const failure = (
    error: ProviderFailure,
    usage: TokenUsage | null = null,
    billing?: BillingUsage,
  ): NormalizedMoveResponse => ({
    ok: false,
    error,
    durationMs: duration(),
    usage,
    ...(billing === undefined ? {} : { billing }),
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
        return {
          ...response,
          output: sanitizeMoveOutput(response.output, input.apiKey),
          durationMs: duration(),
          providerRequestId: null,
        };
      }
      return { ...response, durationMs: duration(), providerRequestId: null };
    }
    const envelope = outputEnvelopeSchema.safeParse(raw);
    return envelope.success
      ? failure(
          { code: "model_invalid", reason: "malformed_output" },
          envelope.data.usage,
          envelope.data.billing,
        )
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
