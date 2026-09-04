import { fileURLToPath } from "node:url";

import { baseTestConfig } from "@neurochess/config/vitest";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

function workspacePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
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
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
    projects: [
      {
        // The web app runs in a browser-like environment with its own setup file.
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/**/*.test.{ts,tsx}"],
          setupFiles: [workspacePath("./apps/web/src/test/setup.ts")],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["apps/api/**/*.test.ts", "packages/**/*.test.ts"],
        },
      },
    ],
  },
});
