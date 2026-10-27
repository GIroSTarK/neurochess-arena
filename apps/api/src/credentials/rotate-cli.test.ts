import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it("returns only a fixed failure for malformed secret files and arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neurochess-rotation-"));
  const file = join(directory, "keys.json");
  const canary = "secret-canary-never-print";
  try {
    await writeFile(file, `{"old":"${canary}`, { mode: 0o600 });
    for (const args of [["rotate", file], [canary], ["rotate", file, canary]]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("./rotate-cli.ts", import.meta.url)), ...args],
        { env: { ...process.env, DATABASE_URL: canary }, encoding: "utf8", timeout: 10000 },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe('{"event":"credential_maintenance","status":"failure"}\n');
      expect(result.stderr).not.toContain(canary);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not expose uncaught database-client errors outside the promise boundary", () => {
  const canary = "secret-canary-never-print";
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(new URL("./rotate-cli.ts", import.meta.url).href)}); throw new Error(${JSON.stringify(canary)});`,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain(canary);
  expect(result.stderr.trim().split("\n")).toEqual([
    '{"event":"credential_maintenance","status":"failure"}',
    '{"event":"credential_maintenance","status":"failure"}',
  ]);
});
