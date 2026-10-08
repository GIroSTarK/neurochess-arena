import { fileURLToPath } from "node:url";

import { baseTestConfig } from "@neurochess/config/vitest";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

function workspacePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

// Keep this allowlist shared by Node inclusion and DOM exclusion. Audit each new
// file (including controller splits) before opting it out of the DOM environment.
const webNodeTestFiles = [
  "apps/web/src/app/route-data.test.ts",
  "apps/web/src/app/fenced-results.test.ts",
  "apps/web/src/position/position.test.ts",
  "apps/web/src/position/squares.test.ts",
  "apps/web/src/position/replay.test.ts",
  "apps/web/src/match/telemetry.test.ts",
  "apps/web/src/match/presentation.test.ts",
  "apps/web/src/match/store.test.ts",
  "apps/web/src/match/controller-lease.test.ts",
  "apps/web/src/match/ai-turn-runner.test.ts",
  "apps/web/src/match/commands.test.ts",
  "apps/web/src/match/invocation-feed.test.ts",
  "apps/web/src/match/seat-credentials.test.ts",
  "apps/web/src/match/session.test.ts",
  "apps/web/src/gameplay/snapshot.test.ts",
  "apps/web/src/sandbox/store.test.ts",
  "apps/web/src/sandbox/presentation.test.ts",
  "apps/web/src/sandbox/controller.commands.test.ts",
  "apps/web/src/sandbox/controller.recovery.test.ts",
  "apps/web/src/sandbox/controller.archive.test.ts",
  "apps/web/src/api/sandbox-client.test.ts",
  "apps/web/src/api/http.test.ts",
  "apps/web/src/api/transport-contract.test.ts",
  "apps/web/src/api/ai-client.test.ts",
  "apps/web/src/app/env.test.ts",
];
const unitTestExclude = [...configDefaults.exclude, "**/*.integration.test.ts"];

export default defineConfig({
  define: {
    __ARENA_REFERENCE_ENABLED__: "true",
    "import.meta.env.SANDBOX_ENABLED": '"true"',
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@neurochess/chess": workspacePath("./packages/chess/src/index.ts"),
      "@neurochess/contracts": workspacePath("./packages/contracts/src/index.ts"),
      "@neurochess/database": workspacePath("./packages/database/src/index.ts"),
    },
  },
  test: {
    ...baseTestConfig,
    exclude: unitTestExclude,
    projects: [
      {
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          exclude: [...unitTestExclude, ...webNodeTestFiles],
          setupFiles: [workspacePath("./apps/web/src/test/setup.ts")],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "apps/api/**/*.test.ts",
            "apps/web/*.test.ts",
            "packages/**/*.test.ts",
            "test/e2e/**/*.test.ts",
            ...webNodeTestFiles,
          ],
        },
      },
    ],
  },
});
