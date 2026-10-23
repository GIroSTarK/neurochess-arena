import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dependencyCruiserDirectory = resolve("node_modules", "dependency-cruiser");
const { bin } = JSON.parse(
  readFileSync(resolve(dependencyCruiserDirectory, "package.json"), "utf8"),
);
const executable = resolve(dependencyCruiserDirectory, bin.depcruise);
const fixtures = [
  {
    path: "apps/web/src/analysis/forbidden-controller-import.ts",
    rule: "analysis-no-controllers-or-api",
  },
  {
    path: "apps/web/src/analysis/forbidden-engine-import.ts",
    rule: "stockfish-only-as-worker-asset",
  },
  {
    path: "apps/web/src/routing/forbidden-app-import.ts",
    rule: "web-routing-no-composition",
  },
  {
    path: "apps/web/src/shell/forbidden-auth-import.ts",
    rule: "web-shell-no-features",
  },
  {
    path: "apps/web/src/match/forbidden-app-import.ts",
    rule: "web-features-no-app-wiring",
  },
  {
    path: "apps/web/src/gameplay/forbidden-routing-import.ts",
    rule: "gameplay-no-features",
  },
  { path: "apps/web/src/auth/forbidden-history-import.ts", rule: "web-auth-feature-imports" },
  {
    path: "apps/web/src/match/forbidden-credential-screen-import.ts",
    rule: "web-match-feature-imports",
  },
  { path: "apps/web/src/match/forbidden-room-route-import.ts", rule: "web-match-feature-imports" },
  { path: "apps/web/src/match/forbidden-room-data-import.ts", rule: "web-match-feature-imports" },
  { path: "apps/web/src/match/forbidden-public-game-import.ts", rule: "web-match-feature-imports" },
  { path: "apps/web/src/rooms/forbidden-public-game-import.ts", rule: "web-rooms-feature-imports" },
  {
    path: "apps/web/src/public-game/forbidden-match-controller-import.ts",
    rule: "web-public-game-feature-imports",
  },
  {
    path: "apps/web/src/public-game/forbidden-room-controller-import.ts",
    rule: "web-public-game-feature-imports",
  },
  {
    path: "apps/web/src/routing/forbidden-public-game-import.ts",
    rule: "web-routing-no-composition",
  },
  { path: "apps/web/src/profile/forbidden-match-import.ts", rule: "web-profile-feature-imports" },
  {
    path: "apps/web/src/gameplay/forbidden-feature-import.ts",
    rule: "gameplay-no-features",
  },
  { path: "apps/api/src/forbidden-scripted-adapter.ts", rule: "api-production-no-test-adapters" },
  { path: "apps/web/forbidden-database-import.ts", rule: "web-no-server-infrastructure" },
  { path: "apps/web/forbidden-engine-import.ts", rule: "chess-engine-is-encapsulated" },
  {
    path: "apps/web/src/arena/forbidden-sandbox-import.ts",
    rule: "arena-presentation-no-sandbox",
  },
  {
    path: "apps/web/src/arena/forbidden-reference-import.ts",
    rule: "arena-presentation-no-sandbox",
  },
  {
    path: "apps/web/src/reference/forbidden-sandbox-import.ts",
    rule: "reference-no-sandbox",
  },
  {
    path: "apps/web/src/arena/forbidden-setup-import.ts",
    rule: "arena-presentation-no-sandbox",
  },
  {
    path: "apps/web/src/setup/forbidden-sandbox-import.ts",
    rule: "ai-setup-no-sandbox",
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
