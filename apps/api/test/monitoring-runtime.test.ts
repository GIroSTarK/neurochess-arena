import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { command, parseConfig, probeEdge } from "../../../scripts/monitoring/runtime.ts";

describe("monitoring process boundaries", () => {
  const config = {
    compartmentId: "ocid1.compartment.oc1..fixture",
    topicId: "ocid1.onstopic.oc1.eu-frankfurt-1.fixture",
    containerName: "neurochess-api",
    directory: process.cwd(),
    diskPath: process.cwd(),
    backupStatusFile: process.cwd(),
    apiOrigin: "https://api.example.com",
    webOrigin: "https://arena.example.com",
  };
  it.each(["ocid1.compartment.oc1..fixture", "ocid1.tenancy.oc1..fixture"])(
    "configures backup alarms in compartment %s without cloud access",
    async (compartmentId) => {
      const directory = await mkdtemp(join(tmpdir(), "nc-monitor-config-"));
      try {
        const configPath = join(directory, "monitor.json");
        const alarms = join(directory, "alarms");
        await writeFile(
          configPath,
          JSON.stringify({ ...config, compartmentId, directory: alarms }),
        );
        await command(process.execPath, [
          join(process.cwd(), "scripts/monitoring/run.ts"),
          "configure",
          configPath,
        ]);
        for (const name of ["BackupFailure", "BackupUnknown", "MonitoringAbsent"]) {
          const alarm = JSON.parse(await readFile(join(alarms, `${name}.json`), "utf8")) as unknown;
          expect(alarm).toMatchObject({
            compartmentId,
            metricCompartmentId: compartmentId,
            destinations: [config.topicId],
            isEnabled: true,
          });
        }
      } finally {
        expect(dirname(directory)).toBe(tmpdir());
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("discards stderr and oversized subprocess output", async () => {
    await expect(
      command(process.execPath, [
        "-e",
        "process.stderr.write('private-command-canary');process.exit(1)",
      ]),
    ).rejects.toThrow("MONITOR_COMMAND_FAILED");
    await expect(
      command(process.execPath, ["-e", "process.stdout.write('x'.repeat(40000))"]),
    ).rejects.toThrow("MONITOR_COMMAND_FAILED");
  });
  it("rejects secret URLs, invalid names and arbitrary cadence at configuration boundaries", () => {
    expect(parseConfig(config).containerName).toBe("neurochess-api");
    for (const changed of [
      { compartmentId: "https://secret.example" },
      { compartmentId: "ocid1.user.oc1..fixture" },
      { compartmentId: "ocid1.tenancy.oc1.." },
      { compartmentId: "ocid1.tenancy.oc1.eu-frankfurt-1.fixture" },
      { compartmentId: "ocid1.tenancy.oc2..fixture" },
      { compartmentId: "ocid1.tenancy.oc1..fixture with spaces" },
      { containerName: "--privileged" },
      { directory: "relative" },
      { backupMaxAgeSeconds: -1 },
      { apiOrigin: "https://secret@api.example.com" },
    ]) {
      expect(() => parseConfig({ ...config, ...changed })).toThrow("INVALID_MONITOR_CONFIG");
    }
  });
  it("detects HTTPS/proxy failure independently of a healthy internal API", async () => {
    expect(
      await probeEdge(
        "https://api.example.com",
        "https://arena.example.com",
        async () => new Response(null, { status: 200 }),
      ),
    ).toBe(true);
    expect(
      await probeEdge(
        "https://api.example.com",
        "https://arena.example.com",
        async () => new Response(null, { status: 502 }),
      ),
    ).toBe(false);
    expect(
      await probeEdge("https://api.example.com", "https://arena.example.com", async () => {
        throw new Error("private-TLS-canary");
      }),
    ).toBe(false);
  });
});
