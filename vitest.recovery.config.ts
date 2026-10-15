import { defineConfig } from "vitest/config";

import base from "./vitest.config.js";

export default defineConfig({
  resolve: base.resolve ?? {},
  test: {
    environment: "node",
    include: ["test/recovery/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
