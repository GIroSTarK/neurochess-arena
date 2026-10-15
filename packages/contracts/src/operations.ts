import { z } from "zod";

export const operationCounterNames = [
  "httpResponses",
  "httpServerFailures",
  "httpRejected",
  "httpLimited",
  "httpSlow",
  "httpDurationMs",
  "analysisReads",
  "analysisWrites",
  "analysisFailures",
  "providerCalls",
  "providerTimeouts",
  "providerUnavailable",
  "providerUnsupported",
  "providerAuth",
  "providerQuota",
  "modelInvalid",
  "providerCancelled",
  "providerDurationMs",
  "roomAccepted",
  "roomClosed",
  "roomSynchronized",
  "roomFailures",
  "roomRejected",
  "roomTimeouts",
] as const;
export const operationGaugeNames = [
  "databaseReady",
  "uptimeSeconds",
  "processStartedSeconds",
  "rssBytes",
  "eventLoopUtilization",
  "poolWaiting",
  "poolTotal",
  "roomConnections",
] as const;
export type OperationCounter = (typeof operationCounterNames)[number];
export type OperationGauge = (typeof operationGaugeNames)[number];
const measurement = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const operationsSnapshotSchema = z.strictObject({
  protocol: z.literal(1),
  counters: z.record(z.enum(operationCounterNames), measurement),
  gauges: z.record(z.enum(operationGaugeNames), measurement),
});
export type OperationsSnapshot = z.infer<typeof operationsSnapshotSchema>;
