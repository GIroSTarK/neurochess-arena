import { performance } from "node:perf_hooks";

import {
  type OperationCounter,
  operationCounterNames,
  type OperationGauge,
  operationGaugeNames,
  operationsSnapshotSchema,
  type ProviderFailure,
} from "@neurochess/contracts";

export function createOperations() {
  const counters = Object.fromEntries(operationCounterNames.map((key) => [key, 0])) as Record<
    OperationCounter,
    number
  >;
  const gauges = Object.fromEntries(operationGaugeNames.map((key) => [key, 0])) as Record<
    OperationGauge,
    number
  >;
  const started = performance.now();
  gauges.processStartedSeconds = Date.now() / 1000;
  let previousUtilization = performance.eventLoopUtilization();
  return {
    increment(name: OperationCounter, amount = 1) {
      if (!Object.hasOwn(counters, name) || !Number.isFinite(amount) || amount < 0) return;
      counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + amount);
    },
    gauge(name: OperationGauge, value: number) {
      if (!Object.hasOwn(gauges, name) || !Number.isFinite(value)) return;
      gauges[name] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value));
    },
    snapshot() {
      const current = performance.eventLoopUtilization();
      gauges.eventLoopUtilization = performance.eventLoopUtilization(
        current,
        previousUtilization,
      ).utilization;
      previousUtilization = current;
      gauges.uptimeSeconds = (performance.now() - started) / 1000;
      gauges.rssBytes = process.memoryUsage.rss();
      return operationsSnapshotSchema.parse({
        protocol: 1,
        counters: { ...counters },
        gauges: { ...gauges },
      });
    },
  };
}
export type Operations = ReturnType<typeof createOperations>;

// Observability never propagates a failed sink into a game or authorization decision.
export function observe(operations: Operations | undefined, action: (sink: Operations) => void) {
  try {
    if (operations) action(operations);
  } catch {
    /* No raw sink diagnostics or recursive reporting. */
  }
}

export async function observeProvider<T extends { ok: boolean; error?: ProviderFailure }>(
  operations: Operations | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const result = await run();
  observe(operations, (sink) => {
    sink.increment("providerCalls");
    sink.increment("providerDurationMs", Math.max(0, performance.now() - started));
    const failure = result.error;
    if (!failure) return;
    switch (failure.code) {
      case "model_invalid":
        sink.increment("modelInvalid");
        break;
      case "provider_auth":
        sink.increment("providerAuth");
        break;
      case "provider_quota":
        sink.increment("providerQuota");
        break;
      case "provider_timeout":
        sink.increment("providerTimeouts");
        break;
      case "provider_unavailable":
        sink.increment(
          failure.reason === "cancelled"
            ? "providerCancelled"
            : failure.reason === "unsupported_model"
              ? "providerUnsupported"
              : "providerUnavailable",
        );
        break;
    }
  });
  return result;
}
