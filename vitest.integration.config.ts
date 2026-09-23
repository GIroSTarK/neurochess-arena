import { baseTestConfig } from "@neurochess/config/vitest";
import { configDefaults, defineConfig } from "vitest/config";

import base from "./vitest.config.js";

export default defineConfig({
  resolve: base.resolve ?? {},
  test: {
    ...baseTestConfig,
    environment: "node",
    include: [
      "apps/**/*.integration.test.ts",
      "packages/**/*.integration.test.ts",
      "test/e2e/**/*.integration.test.ts",
    ],
    exclude: [...configDefaults.exclude],
    globalSetup: ["./test/integration-setup.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
