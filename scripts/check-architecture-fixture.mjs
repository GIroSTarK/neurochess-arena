import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve("node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
const result = spawnSync(
  process.execPath,
  [
    executable,
    "--config",
    "dependency-cruiser.config.mjs",
    "test-fixtures/architecture/apps/web/forbidden-database-import.ts",
  ],
  { encoding: "utf8" },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

if (result.error !== undefined) {
  throw result.error;
}

if (result.status === 0 || !output.includes("web-no-server-infrastructure")) {
  process.stderr.write(output);
  throw new Error("The architecture fixture was not rejected by the web boundary rule.");
}

process.stdout.write("Architecture guard fixture was rejected as expected.\n");
