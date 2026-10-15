import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createAlertEvaluator,
  deriveSignals,
  ociMetrics,
  parseSnapshot,
  renderDashboard,
  type Snapshot,
} from "./policy.ts";

interface CollectorOptions {
  compartmentId: string;
  directory: string;
}
interface Dependencies {
  scrape(): Promise<unknown>;
  context(): Promise<{
    edgeAvailable?: boolean;
    diskUsedPercent?: number;
    backup?: unknown;
    backupMaxAgeSeconds?: number;
  }>;
  publish(payload: ReturnType<typeof ociMetrics>): Promise<void>;
  event(event: { event: "alert" | "monitor_export"; state: string; alert?: string }): void;
}
export function createCollector(options: CollectorOptions, dependencies: Dependencies) {
  const evaluate = createAlertEvaluator();
  let previous: Snapshot | null = null;
  let previousTime: number | undefined;
  let exportFailed = false;
  let running = false;
  return {
    async tick(now: number) {
      if (running) return;
      running = true;
      try {
        let snapshot: Snapshot | null = null;
        let context: Awaited<ReturnType<Dependencies["context"]>> = {};
        try {
          snapshot = parseSnapshot(await dependencies.scrape());
        } catch {
          /* Fixed absence signal only. */
        }
        try {
          context = await dependencies.context();
        } catch {
          /* Missing resource/backup evidence is unhealthy. */
        }
        const signals = deriveSignals(snapshot, previous, {
          ...context,
          now,
          intervalSeconds: previousTime === undefined ? 0 : (now - previousTime) / 1000,
        });
        previous = snapshot;
        previousTime = now;
        const { active, transitions } = evaluate(signals, now);
        for (const transition of transitions) dependencies.event({ event: "alert", ...transition });
        try {
          await dependencies.publish(ociMetrics(options.compartmentId, signals, active, now));
          if (exportFailed) dependencies.event({ event: "monitor_export", state: "recovered" });
          exportFailed = false;
        } catch {
          if (!exportFailed) dependencies.event({ event: "monitor_export", state: "failed" });
          exportFailed = true;
        }
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        const files: [string, string][] = [
          [
            "status.json",
            JSON.stringify({
              at: new Date(now).toISOString(),
              exportAvailable: !exportFailed,
              signals,
              active,
            }),
          ],
          ["dashboard.html", renderDashboard(signals, active, now, !exportFailed)],
        ];
        for (const [name, data] of files) {
          const target = join(options.directory, name);
          await writeFile(target + ".tmp", data, { mode: 0o600 });
          await rename(target + ".tmp", target);
        }
      } finally {
        running = false;
      }
    },
  };
}
