import { configDefaults, defineConfig } from "vitest/config";

import base from "./vitest.config.js";

export default defineConfig({
  resolve: base.resolve ?? {},
  test: {
    ...base.test,
    include: ["apps/**/*.integration.test.ts", "packages/**/*.integration.test.ts"],
    exclude: [...configDefaults.exclude],
    setupFiles: [],
    globalSetup: ["./test/integration-setup.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
