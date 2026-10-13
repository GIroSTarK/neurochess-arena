import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { WEB_ORIGIN } from "./test/e2e/environment";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : "50%",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["./test/e2e/duration-reporter.ts"]],
  globalSetup: "./test/e2e/global-setup.ts",
  outputDir: join(tmpdir(), "neurochess-playwright-results"),
  use: {
    baseURL: WEB_ORIGIN,
    ignoreHTTPSErrors: true,
    // Traces/HARs can retain guest cookie headers. Capture only rendered pixels.
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1080 } },
    },
    {
      name: "chromium-mobile",
      // Desktop projects cover lease timing; both touch projects retain recovery journeys.
      grepInvert: /@controller-protocol/,
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "firefox-desktop",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 1080 } },
    },
    {
      name: "webkit-desktop",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 1080 } },
    },
    {
      name: "webkit-mobile",
      grepInvert: /@controller-protocol/,
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
    },
  ],
});
