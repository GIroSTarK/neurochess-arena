import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCollector } from "../../../scripts/monitoring/collector.ts";
import { createOperations } from "../src/monitoring/operations.js";

describe("isolated monitoring collector", () => {
  it("writes a private dashboard, bounds output, and recovers from OCI and scrape failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nc-monitor-test-"));
    try {
      let offline = false,
        sinkBroken = true;
      const payloads: unknown[] = [];
      const events: unknown[] = [];
      const operations = createOperations();
      const collector = createCollector(
        { compartmentId: "ocid1.compartment.oc1..fixture", directory },
        {
          async scrape() {
            if (offline) throw new Error("private-scrape-canary");
            operations.gauge("databaseReady", 1);
            return operations.snapshot();
          },
          async context() {
            return {
              edgeAvailable: true,
              diskUsedPercent: 10,
              backup: { status: "success", completedAt: "2026-10-15T00:00:00.000Z" },
              backupMaxAgeSeconds: 3600,
            };
          },
          async publish(payload) {
            payloads.push(payload);
            if (sinkBroken) throw new Error("private-oci-canary");
          },
          event: (event) => events.push(event),
        },
      );
      const now = Date.parse("2026-10-15T00:00:00.000Z");
      await collector.tick(now);
      expect(await readFile(join(directory, "dashboard.html"), "utf8")).toContain(
        "Cloud export: unavailable",
      );
      sinkBroken = false;
      await collector.tick(now + 60_000);
      offline = true;
      await collector.tick(now + 120_000);
      await collector.tick(now + 180_000);
      await collector.tick(now + 240_000);
      expect(await readFile(join(directory, "dashboard.html"), "utf8")).toContain(
        "ApiUnavailable: FIRING",
      );
      offline = false;
      await collector.tick(now + 300_000);
      const status = JSON.parse(await readFile(join(directory, "status.json"), "utf8")) as {
        active: { ApiUnavailable: boolean };
      };
      expect(status.active.ApiUnavailable).toBe(false);
      expect(events).toContainEqual({ event: "monitor_export", state: "failed" });
      expect(events).toContainEqual({ event: "monitor_export", state: "recovered" });
      expect(events).toContainEqual({ event: "alert", alert: "ApiUnavailable", state: "resolved" });
      expect(JSON.stringify([events, payloads, status])).not.toContain("canary");
    } finally {
      expect(dirname(directory)).toBe(tmpdir());
      await rm(directory, { recursive: true, force: true });
    }
  });
});
