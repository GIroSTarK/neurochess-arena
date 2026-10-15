import { describe, expect, it } from "vitest";

import {
  createAlertEvaluator,
  deriveSignals,
  ociAlarms,
  ociMetrics,
  renderDashboard,
} from "../../../scripts/monitoring/policy.ts";
import { createOperations } from "../src/monitoring/operations.js";

const healthy = () => ({
  ...createOperations().snapshot(),
  gauges: {
    ...createOperations().snapshot().gauges,
    databaseReady: 1,
    uptimeSeconds: 120,
    rssBytes: 100_000_000,
    eventLoopUtilization: 0.1,
  },
});
const backup = { status: "success", completedAt: "2026-10-15T00:00:00.000Z" };
const at = Date.parse(backup.completedAt);
const signals = () =>
  deriveSignals(healthy(), healthy(), {
    edgeAvailable: true,
    diskUsedPercent: 30,
    backup,
    backupMaxAgeSeconds: 3600,
    now: at,
  });

describe("private operational alert policy", () => {
  it.each([
    { alert: "ApiUnavailable", changed: { edgeAvailable: 0 }, seconds: 120 },
    { alert: "DatabaseUnavailable", changed: { databaseReady: 0 }, seconds: 120 },
    { alert: "ServerFailures", changed: { serverFailures: 5 }, seconds: 120 },
    { alert: "ResourcePressure", changed: { poolWaiting: 1 }, seconds: 300 },
    { alert: "ResourcePressure", changed: { rssBytes: 1_000_000_000 }, seconds: 300 },
    { alert: "ResourcePressure", changed: { diskUsedPercent: 85 }, seconds: 300 },
    { alert: "ResourcePressure", changed: { eventLoopUtilization: 0.95 }, seconds: 300 },
    { alert: "ProviderFailures", changed: { providerFailures: 3 }, seconds: 120 },
    { alert: "RoomRecoveryFailures", changed: { roomFailures: 5 }, seconds: 120 },
    { alert: "RoomRecoveryFailures", changed: { roomDisconnects: 30 }, seconds: 120 },
    { alert: "AnalysisFailures", changed: { analysisFailures: 5 }, seconds: 120 },
    { alert: "SlowRequests", changed: { slowRequests: 10 }, seconds: 300 },
    { alert: "BackupFailure", changed: { backupFailure: 1 }, seconds: 0 },
    { alert: "BackupUnknown", changed: { backupUnknown: 1 }, seconds: 0 },
  ])("generates and resolves $alert from a controlled fault", ({ alert, changed, seconds }) => {
    const evaluate = createAlertEvaluator();
    const observed = [];
    for (let elapsed = 0; elapsed <= seconds; elapsed += 60) {
      observed.push(...evaluate({ ...signals(), ...changed }, at + elapsed * 1000).transitions);
    }
    expect(observed).toEqual([{ alert, state: "firing" }]);
    expect(evaluate(signals(), at + (seconds + 60) * 1000).transitions).toEqual([
      { alert, state: "resolved" },
    ]);
  });
  it("fires sustained outages once, resolves on recovery and separates provider/model failures", () => {
    const evaluate = createAlertEvaluator();
    const bad = { ...signals(), apiAvailable: 0 };
    expect(evaluate(bad, at).transitions).toEqual([]);
    expect(evaluate(bad, at + 60_000).transitions).toEqual([]);
    expect(evaluate(bad, at + 120_000).transitions).toEqual([
      { alert: "ApiUnavailable", state: "firing" },
    ]);
    expect(evaluate(bad, at + 180_000).transitions).toEqual([]);
    expect(evaluate(signals(), at + 240_000).transitions).toEqual([
      { alert: "ApiUnavailable", state: "resolved" },
    ]);
    const sample = healthy();
    sample.counters.modelInvalid = 100;
    sample.counters.providerAuth = 100;
    sample.counters.providerQuota = 100;
    sample.counters.providerCancelled = 100;
    expect(
      deriveSignals(sample, healthy(), {
        diskUsedPercent: 30,
        backup,
        backupMaxAgeSeconds: 3600,
        now: at,
      }).providerFailures,
    ).toBe(0);
    sample.counters.providerTimeouts = 3;
    expect(
      deriveSignals(sample, healthy(), {
        diskUsedPercent: 30,
        backup,
        backupMaxAgeSeconds: 3600,
        now: at,
      }).providerFailures,
    ).toBe(3);
  });

  it("treats missing, invalid, future and stale backup evidence as unhealthy without inventing a schedule", () => {
    for (const value of [
      undefined,
      { status: "success", completedAt: "private-canary" },
      { status: "success", completedAt: new Date(at + 1000).toISOString() },
    ]) {
      expect(
        deriveSignals(healthy(), null, {
          diskUsedPercent: 0,
          backup: value,
          backupMaxAgeSeconds: 3600,
          now: at,
        }).backupUnknown,
      ).toBe(1);
    }
    expect(
      deriveSignals(healthy(), null, { diskUsedPercent: 0, backup, now: at }).backupUnknown,
    ).toBe(1);
    expect(
      deriveSignals(healthy(), null, {
        diskUsedPercent: 0,
        backup,
        backupMaxAgeSeconds: 3600,
        now: at + 3_601_000,
      }).backupFailure,
    ).toBe(1);
    expect(
      deriveSignals(healthy(), null, {
        diskUsedPercent: 0,
        backup: { ...backup, status: "failure" },
        now: at,
      }).backupFailure,
    ).toBe(1);
  });
  it("keeps a backup failure open when its status becomes unreadable", () => {
    const evaluate = createAlertEvaluator();
    expect(evaluate({ ...signals(), backupFailure: 1 }, at).active.BackupFailure).toBe(true);
    expect(evaluate({ ...signals(), backupUnknown: 1 }, at + 60_000).active.BackupFailure).toBe(
      true,
    );
    expect(evaluate(signals(), at + 120_000).active.BackupFailure).toBe(false);
  });

  it("handles restarts and telemetry failure without negative rates or private payloads", () => {
    const previous = healthy();
    previous.counters.httpServerFailures = 100;
    const restarted = healthy();
    restarted.gauges.uptimeSeconds = 1;
    restarted.counters.httpServerFailures = 2;
    const result = deriveSignals(restarted, previous, {
      diskUsedPercent: 30,
      backup,
      backupMaxAgeSeconds: 3600,
      now: at,
    });
    expect(result.serverFailures).toBe(2);
    expect(result.restarted).toBe(1);
    const later = {
      ...restarted,
      gauges: { ...restarted.gauges, uptimeSeconds: 200, processStartedSeconds: 200 },
    };
    expect(
      deriveSignals(
        later,
        { ...previous, gauges: { ...previous.gauges, processStartedSeconds: 100 } },
        { now: at },
      ).restarted,
    ).toBe(1);
    expect(
      deriveSignals({ protocol: 1, counters: { secret: "private-canary" } }, previous, { now: at })
        .apiAvailable,
    ).toBe(0);
    const evaluated = createAlertEvaluator()(result, at);
    const payload = ociMetrics("ocid1.compartment.oc1..fixture", result, evaluated.active, at);
    expect(
      payload.every((metric) => JSON.stringify(metric.dimensions) === '{"service":"arena"}'),
    ).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("canary");
    expect(renderDashboard(result, evaluated.active, at)).toContain("Database ready");
    expect(renderDashboard(result, evaluated.active, at)).not.toContain("<script");
    const alarms = ociAlarms(
      "ocid1.compartment.oc1..fixture",
      "ocid1.onstopic.oc1.eu-frankfurt-1.fixture",
    );
    expect(alarms.find((alarm) => alarm.displayName === "MonitoringAbsent")?.query).toBe(
      'Heartbeat[1m]{service = "arena"}.groupBy(service).absent(72h)',
    );
    expect(alarms.every((alarm) => alarm.body.includes("Responder: deployment owner"))).toBe(true);
  });
  it("keeps a firing incident open across missing observations and fences a new pending period", () => {
    const evaluate = createAlertEvaluator();
    const failed = { ...signals(), apiAvailable: 0 };
    for (const offset of [0, 60_000, 120_000]) evaluate(failed, at + offset);
    expect(evaluate(failed, at + 360_000).active.ApiUnavailable).toBe(true);
  });
  it("does not resolve failures or publish measured zeroes through a lost scrape and recovery baseline", () => {
    const evaluate = createAlertEvaluator();
    const failed = {
      ...signals(),
      serverFailures: 5,
      providerFailures: 3,
      roomFailures: 5,
      analysisFailures: 5,
      rssBytes: 1_000_000_000,
    };
    for (let seconds = 0; seconds <= 300; seconds += 60) evaluate(failed, at + seconds * 1000);
    const missing = deriveSignals(null, healthy(), {
      now: at,
      edgeAvailable: true,
      diskUsedPercent: 10,
      backup,
      backupMaxAgeSeconds: 3600,
    });
    const state = evaluate(missing, at + 360_000);
    expect(state.transitions).toEqual([]);
    expect(state.active).toMatchObject({
      ServerFailures: true,
      ProviderFailures: true,
      RoomRecoveryFailures: true,
      AnalysisFailures: true,
      ResourcePressure: true,
    });
    expect(
      ociMetrics("ocid1.compartment.oc1..fixture", missing, state.active, at).some(
        (metric) => metric.name === "serverFailures",
      ),
    ).toBe(false);
    expect(renderDashboard(missing, state.active, at)).toContain("unavailable");
    const baseline = deriveSignals(healthy(), null, {
      now: at,
      edgeAvailable: true,
      diskUsedPercent: 10,
      backup,
      backupMaxAgeSeconds: 3600,
    });
    expect(evaluate(baseline, at + 420_000).active.ServerFailures).toBe(true);
    expect(evaluate(signals(), at + 480_000).active.ServerFailures).toBe(false);
  });
});
