import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve("node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
const fixtures = [
  { path: "apps/web/forbidden-database-import.ts", rule: "web-no-server-infrastructure" },
  { path: "apps/web/forbidden-engine-import.ts", rule: "chess-engine-is-encapsulated" },
  {
    path: "apps/web/src/arena/forbidden-sandbox-import.ts",
    rule: "arena-presentation-no-sandbox",
  },
  { path: "apps/api/forbidden-chess-internal-import.ts", rule: "chess-public-entrypoint-only" },
  { path: "packages/chess/forbidden-fastify-import.ts", rule: "shared-leaves-no-infrastructure" },
  {
    path: "packages/contracts/forbidden-drizzle-import.ts",
    rule: "shared-leaves-no-infrastructure",
  },
  { path: "packages/chess/forbidden-node-import.ts", rule: "shared-leaves-no-node-builtins" },
  { path: "packages/chess/forbidden-contracts-import.ts", rule: "chess-remains-a-leaf" },
  { path: "packages/contracts/forbidden-chess-import.ts", rule: "contracts-remain-a-leaf" },
  {
    path: "packages/chess/src/forbidden-fixture-import.ts",
    rule: "chess-production-no-test-helpers",
  },
].map((fixture) => ({ ...fixture, path: `test-fixtures/architecture/${fixture.path}` }));
const result = spawnSync(
  process.execPath,
  [
    executable,
    "--config",
    "dependency-cruiser.config.mjs",
    "--output-type",
    "json",
    ...fixtures.map((fixture) => fixture.path),
  ],
  { encoding: "utf8" },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

if (result.error !== undefined) {
  throw result.error;
}

if (result.status === null || result.stdout.trim() === "") {
  process.stderr.write(output);
  throw new Error("The architecture fixture check did not produce a report.");
}

// The JSON reporter reports violations in its summary, not in its exit status.
const report = JSON.parse(result.stdout);
if (report.summary.error === 0) {
  throw new Error("The deliberately invalid architecture fixtures were not rejected.");
}
for (const fixture of fixtures) {
  if (
    !report.summary.violations.some(
      (violation) => violation.from === fixture.path && violation.rule.name === fixture.rule,
    )
  ) {
    process.stderr.write(JSON.stringify(report.summary.violations, null, 2));
    throw new Error(`Architecture fixture ${fixture.path} was not rejected by ${fixture.rule}.`);
  }
}

process.stdout.write(
  `All ${fixtures.length} architecture guard fixtures were rejected as expected.\n`,
);
