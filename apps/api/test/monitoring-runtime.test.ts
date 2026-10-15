import { describe, expect, it } from "vitest";

import { command, parseConfig, probeEdge } from "../../../scripts/monitoring/runtime.ts";

describe("monitoring process boundaries", () => {
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
    expect(parseConfig(config).containerName).toBe("neurochess-api");
    for (const changed of [
      { compartmentId: "https://secret.example" },
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
