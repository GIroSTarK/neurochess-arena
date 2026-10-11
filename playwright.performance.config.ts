import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { WEB_ORIGIN } from "./test/e2e/environment";

export default defineConfig({
  testDir: "./test/performance",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  globalSetup: "./test/performance/global-setup.ts",
  outputDir: join(tmpdir(), "neurochess-performance-results"),
  use: { baseURL: WEB_ORIGIN, trace: "off", screenshot: "only-on-failure", video: "off" },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1080 } },
    },
    { name: "mobile-touch", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
});
