const counters = [
  "httpResponses",
  "httpServerFailures",
  "httpLimited",
  "httpSlow",
  "httpDurationMs",
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
  "roomClosed",
  "roomFailures",
  "roomTimeouts",
] as const;
const gauges = [
  "databaseReady",
  "uptimeSeconds",
  "processStartedSeconds",
  "rssBytes",
  "eventLoopUtilization",
  "poolWaiting",
  "roomConnections",
] as const;
export interface Snapshot {
  protocol: 1;
  counters: Record<(typeof counters)[number], number>;
  gauges: Record<(typeof gauges)[number], number>;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function finite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}
export function parseSnapshot(value: unknown): Snapshot | null {
  const root = record(value);
  if (root.protocol !== 1) return null;
  const c = record(root.counters),
    g = record(root.gauges);
  if (!counters.every((key) => finite(c[key])) || !gauges.every((key) => finite(g[key]))) {
    return null;
  }
  if (Number(g.databaseReady) > 1 || Number(g.eventLoopUtilization) > 1) return null;
  // Reconstruct only fixed numeric fields, discarding all other input before retention/export.
  return {
    protocol: 1,
    counters: Object.fromEntries(counters.map((key) => [key, c[key]])) as Snapshot["counters"],
    gauges: Object.fromEntries(gauges.map((key) => [key, g[key]])) as Snapshot["gauges"],
  };
}
interface Context {
  now: number;
  intervalSeconds?: number;
  edgeAvailable?: boolean;
  diskUsedPercent?: number;
  backup?: unknown;
  backupMaxAgeSeconds?: number;
}
export function deriveSignals(current: unknown, previous: unknown, context: Context) {
  const sample = parseSnapshot(current),
    before = parseSnapshot(previous);
  const restarted = Boolean(
    sample &&
    before &&
    (sample.gauges.processStartedSeconds !== before.gauges.processStartedSeconds ||
      sample.gauges.uptimeSeconds < before.gauges.uptimeSeconds),
  );
  const interval = context.intervalSeconds ?? 60;
  const counterWindowAvailable = Boolean(sample && before && interval > 0 && interval <= 90);
  const delta = (key: (typeof counters)[number]) =>
    sample && before && counterWindowAvailable
      ? Math.max(0, sample.counters[key] - (restarted ? 0 : before.counters[key]))
      : 0;
  const backup = record(context.backup);
  const completed = typeof backup.completedAt === "string" ? Date.parse(backup.completedAt) : NaN;
  const started =
    backup.startedAt === undefined
      ? completed
      : typeof backup.startedAt === "string"
        ? Date.parse(backup.startedAt)
        : NaN;
  const validBackup =
    ["success", "failure"].includes(String(backup.status)) &&
    Number.isFinite(completed) &&
    Number.isFinite(started) &&
    started <= completed &&
    completed <= context.now;
  const cadence = finite(context.backupMaxAgeSeconds) && context.backupMaxAgeSeconds > 0;
  const backupFailure =
    validBackup &&
    (backup.status === "failure" ||
      (cadence && context.now - started > (context.backupMaxAgeSeconds ?? 0) * 1000));
  return {
    apiAvailable: Number(Boolean(sample)),
    counterWindowAvailable: Number(counterWindowAvailable),
    databaseReady: sample?.gauges.databaseReady ?? 0,
    edgeAvailable: Number(context.edgeAvailable === true),
    serverFailures: delta("httpServerFailures"),
    slowRequests: delta("httpSlow"),
    requests: delta("httpResponses"),
    limitedRequests: delta("httpLimited"),
    meanHttpLatencyMs: delta("httpResponses")
      ? delta("httpDurationMs") / delta("httpResponses")
      : 0,
    analysisFailures: delta("analysisFailures"),
    providerFailures: delta("providerTimeouts") + delta("providerUnavailable"),
    providerTimeouts: delta("providerTimeouts"),
    providerAuth: delta("providerAuth"),
    providerUnsupported: delta("providerUnsupported"),
    providerQuota: delta("providerQuota"),
    modelInvalid: delta("modelInvalid"),
    providerCancelled: delta("providerCancelled"),
    meanProviderLatencyMs: delta("providerCalls")
      ? delta("providerDurationMs") / delta("providerCalls")
      : 0,
    roomFailures: delta("roomFailures") + delta("roomTimeouts"),
    roomDisconnects: delta("roomClosed"),
    roomConnections: sample?.gauges.roomConnections ?? 0,
    rssBytes: sample?.gauges.rssBytes ?? 0,
    eventLoopUtilization: sample?.gauges.eventLoopUtilization ?? 0,
    poolWaiting: sample?.gauges.poolWaiting ?? 0,
    diskUsedPercent:
      finite(context.diskUsedPercent) && context.diskUsedPercent <= 100
        ? context.diskUsedPercent
        : 100,
    backupFailure: Number(backupFailure),
    backupUnknown: Number(!validBackup || (!cadence && backup.status !== "failure")),
    restarted: Number(restarted),
  };
}
export type Signals = ReturnType<typeof deriveSignals>;

export const alertRules = [
  {
    id: "ApiUnavailable",
    seconds: 120,
    severity: "CRITICAL",
    test: (s: Signals) => !s.apiAvailable || !s.edgeAvailable,
    action:
      "Check Caddy/public HTTPS, container exit status, /health and rollout state. Keep one API owner; follow restart recovery.",
  },
  {
    id: "DatabaseUnavailable",
    seconds: 120,
    severity: "CRITICAL",
    test: (s: Signals) => Boolean(s.apiAvailable && !s.databaseReady),
    action:
      "Check PostgreSQL health, TLS certificate expiry, disk and pool waits. Do not replace volumes or secrets.",
  },
  {
    id: "ServerFailures",
    seconds: 120,
    severity: "CRITICAL",
    test: (s: Signals) => s.serverFailures >= 5,
    action:
      "Check database readiness and fixed error codes, then compare the release. Follow schema-compatible rollback if needed.",
  },
  {
    id: "ResourcePressure",
    seconds: 300,
    severity: "WARNING",
    test: (s: Signals) =>
      s.rssBytes >= 900 * 1024 * 1024 ||
      s.eventLoopUtilization >= 0.9 ||
      s.poolWaiting > 0 ||
      s.diskUsedPercent >= 85 ||
      s.roomConnections >= 900,
    action:
      "Check memory, event-loop load, database waits and disk. Stop nonessential work; do not add a second API owner.",
  },
  {
    id: "ProviderFailures",
    seconds: 120,
    severity: "WARNING",
    test: (s: Signals) => s.providerFailures >= 3,
    action:
      "Check provider status and outbound connectivity. Games stay paused for explicit user retry; never replay inference automatically.",
  },
  {
    id: "RoomRecoveryFailures",
    seconds: 120,
    severity: "WARNING",
    test: (s: Signals) => s.roomFailures >= 5 || s.roomDisconnects >= 30,
    action:
      "Check API/database availability, proxy upgrades and connection pressure. Clients resynchronize; do not change game results.",
  },
  {
    id: "AnalysisFailures",
    seconds: 120,
    severity: "WARNING",
    test: (s: Signals) => s.analysisFailures >= 5,
    action:
      "Check database health and analysis API failures. Chess remains independent; clients retain explicit persistence retry.",
  },
  {
    id: "SlowRequests",
    seconds: 300,
    severity: "WARNING",
    test: (s: Signals) => s.slowRequests >= 10,
    action:
      "Check database waits, event-loop load and resource pressure. Provider turn/discovery latency is displayed separately.",
  },
  {
    id: "BackupFailure",
    seconds: 0,
    severity: "CRITICAL",
    test: (s: Signals) => Boolean(s.backupFailure),
    action:
      "Inspect the backup job exit status and destination capacity/access. Preserve the last good copy; follow the approved recovery runbook.",
  },
  {
    id: "BackupUnknown",
    seconds: 0,
    severity: "WARNING",
    test: (s: Signals) => Boolean(s.backupUnknown),
    action:
      "Backup evidence or agreed cadence is missing. Configure the P5-14 status producer and maximum age before release; do not claim recoverability.",
  },
] as const;
export type AlertId = (typeof alertRules)[number]["id"];
export type ActiveAlerts = Record<AlertId, boolean>;
function observationAvailable(alert: AlertId, signals: Signals) {
  if (alert === "BackupFailure") return Boolean(!signals.backupUnknown || signals.backupFailure);
  if (alert === "DatabaseUnavailable") return Boolean(signals.apiAvailable);
  if (alert === "ResourcePressure") {
    return Boolean(signals.apiAvailable || signals.diskUsedPercent >= 85);
  }
  if (
    [
      "ServerFailures",
      "ProviderFailures",
      "RoomRecoveryFailures",
      "AnalysisFailures",
      "SlowRequests",
    ].includes(alert)
  ) {
    return Boolean(signals.counterWindowAvailable);
  }
  return true;
}
export function createAlertEvaluator() {
  const since = new Map<AlertId, number>();
  const active = Object.fromEntries(alertRules.map(({ id }) => [id, false])) as ActiveAlerts;
  let previousTime: number | undefined;
  return (signals: Signals, now: number) => {
    // A missed collection interval cannot establish continuous failure.
    if (previousTime !== undefined && (now - previousTime > 90_000 || now < previousTime)) {
      since.clear();
    }
    previousTime = now;
    const transitions: { alert: AlertId; state: "firing" | "resolved" }[] = [];
    for (const rule of alertRules) {
      if (!observationAvailable(rule.id, signals)) {
        since.delete(rule.id);
        continue;
      }
      if (rule.test(signals)) since.set(rule.id, since.get(rule.id) ?? now);
      else since.delete(rule.id);
      const start = since.get(rule.id);
      const next = start !== undefined && (active[rule.id] || now - start >= rule.seconds * 1000);
      if (next !== active[rule.id]) {
        transitions.push({ alert: rule.id, state: next ? "firing" : "resolved" });
      }
      active[rule.id] = next;
    }
    return { active: { ...active }, transitions };
  };
}

const labels: Record<keyof Signals, string> = {
  counterWindowAvailable: "Counter interval available",
  edgeAvailable: "Public web/API HTTPS reachable",
  apiAvailable: "API available",
  databaseReady: "Database ready",
  serverFailures: "Server failures",
  slowRequests: "Slow requests",
  requests: "HTTP responses",
  limitedRequests: "Rate limited requests",
  meanHttpLatencyMs: "Mean HTTP latency (ms)",
  analysisFailures: "Analysis persistence failures",
  providerFailures: "Provider infrastructure failures",
  providerTimeouts: "Provider timeouts",
  providerAuth: "Provider authentication failures",
  providerUnsupported: "Unsupported model selections",
  providerQuota: "Provider quota failures",
  modelInvalid: "Invalid model outputs",
  providerCancelled: "Cancelled provider work",
  meanProviderLatencyMs: "Mean provider latency (ms)",
  roomFailures: "Room recovery failures",
  roomDisconnects: "Room disconnects",
  roomConnections: "Room connections",
  rssBytes: "API RSS (bytes)",
  eventLoopUtilization: "Event-loop utilization",
  poolWaiting: "Database pool waiters",
  diskUsedPercent: "Host disk used (%)",
  backupFailure: "Backup failed or stale",
  backupUnknown: "Backup evidence unknown",
  restarted: "API restarted",
};
const counterSignals: readonly (keyof Signals)[] = [
  "requests",
  "limitedRequests",
  "serverFailures",
  "slowRequests",
  "meanHttpLatencyMs",
  "analysisFailures",
  "providerFailures",
  "providerTimeouts",
  "providerAuth",
  "providerUnsupported",
  "providerQuota",
  "modelInvalid",
  "providerCancelled",
  "meanProviderLatencyMs",
  "roomFailures",
  "roomDisconnects",
  "restarted",
];
const apiGauges: readonly (keyof Signals)[] = [
  "databaseReady",
  "rssBytes",
  "eventLoopUtilization",
  "poolWaiting",
  "roomConnections",
];
function measurementAvailable(name: keyof Signals, signals: Signals) {
  return (
    (!counterSignals.includes(name) || Boolean(signals.counterWindowAvailable)) &&
    (!apiGauges.includes(name) || Boolean(signals.apiAvailable))
  );
}
export function renderDashboard(
  signals: Signals,
  active: ActiveAlerts,
  now: number,
  exportAvailable = true,
) {
  const rows = (Object.keys(labels) as (keyof Signals)[])
    .map(
      (key) =>
        `<tr><th>${labels[key]}</th><td>${measurementAvailable(key, signals) ? signals[key].toFixed(2) : "unavailable"}</td></tr>`,
    )
    .join("");
  const states = alertRules
    .map(
      (rule) =>
        `<li>${rule.id}: ${active[rule.id] ? "FIRING — " + rule.action : observationAvailable(rule.id, signals) ? "clear" : "unavailable"}</li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Private arena operations</title><style>body{font:18px system-ui;max-width:900px;margin:2rem auto;padding:1rem;background:#111827;color:#f9fafb}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.4rem;border-bottom:1px solid #64748b}li{margin:.5rem 0}</style><h1>Private arena operations</h1><p>Snapshot: ${new Date(now).toISOString()}. Stale after 90 seconds. Counters describe the last collection interval; first collection establishes a baseline.</p><p>Cloud export: ${exportAvailable ? "available" : "unavailable — inspect collector/IAM/OCI ingestion"}.</p><h2>Alerts</h2><ul>${states}</ul><h2>Current signals</h2><table><tbody>${rows}</tbody></table></html>`;
}
export function ociMetrics(
  compartmentId: string,
  signals: Signals,
  active: ActiveAlerts,
  now: number,
) {
  const values = {
    Heartbeat: 1,
    ...Object.fromEntries(
      (Object.keys(labels) as (keyof Signals)[])
        .filter((name) => measurementAvailable(name, signals))
        .map((name) => [name, signals[name]]),
    ),
    ...Object.fromEntries(
      alertRules
        .filter(({ id }) => observationAvailable(id, signals) || active[id])
        .map(({ id }) => [id, Number(active[id])]),
    ),
  };
  return Object.entries(values).map(([name, value]) => ({
    namespace: "neurochess_ops",
    compartmentId,
    name,
    dimensions: { service: "arena" },
    datapoints: [{ timestamp: new Date(now).toISOString(), value, count: 1 }],
  }));
}
export function ociAlarms(compartmentId: string, topic: string) {
  return [
    ...alertRules.map((rule) => ({
      displayName: rule.id,
      query: `${rule.id}[1m]{service = "arena"}.max() > 0`,
      severity: rule.severity,
      pendingDuration: "PT1M",
      body: `Responder: deployment owner. ${rule.action} See docs/operations.md#operational-monitoring.`,
    })),
    {
      displayName: "MonitoringAbsent",
      query: 'Heartbeat[1m]{service = "arena"}.groupBy(service).absent(72h)',
      severity: "CRITICAL",
      pendingDuration: "PT5M",
      body: "Responder: deployment owner. Check VM reachability, collector service, OCI agent/IAM, ingestion and topic delivery. Missing telemetry is not healthy; an OCI RESET after 72h is not recovery. See docs/operations.md#operational-monitoring.",
    },
  ].map((alarm) => ({
    ...alarm,
    compartmentId,
    metricCompartmentId: compartmentId,
    namespace: "neurochess_ops",
    destinations: [topic],
    resolution: "1m",
    isEnabled: true,
    repeatNotificationDuration: "PT1H",
    messageFormat: "ONS_OPTIMIZED",
  }));
}
