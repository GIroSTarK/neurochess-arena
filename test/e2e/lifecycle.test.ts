import { describe, expect, it } from "vitest";

import { closeResources, startBrowserTestServer } from "./lifecycle.js";

const fixture = new URL("./lifecycle-fixture.ts", import.meta.url);

describe("browser test server lifecycle", () => {
  it("waits for confirmed cleanup and process exit, and permits repeated teardown", async () => {
    const stop = await startBrowserTestServer(fixture, { args: ["clean"] });
    await stop();
    await stop();
  });

  it.each([
    ["missing-ack", "without confirming cleanup"],
    ["failed", "lifecycle failure"],
    ["hang", "shutdown timed out"],
    ["hang-after-ack", "shutdown timed out"],
  ])("rejects %s teardown instead of reporting a passing cleanup", async (mode, message) => {
    const stop = await startBrowserTestServer(fixture, {
      args: [mode],
      shutdownTimeout: 300,
    });
    await expect(stop()).rejects.toThrow(message);
  });

  it("rejects a process that exits before readiness", async () => {
    await expect(startBrowserTestServer(fixture, { args: ["early-exit"] })).rejects.toThrow(
      "exited unexpectedly",
    );
  });

  it("cleans up a process that never becomes ready", async () => {
    await expect(
      startBrowserTestServer(fixture, { args: ["no-ready"], startupTimeout: 300 }),
    ).rejects.toThrow("startup timed out");
  });

  it("still attempts data cleanup and pool closure after earlier resources fail", async () => {
    const attempted: string[] = [];
    await expect(
      closeResources(
        ["web", "API", "test guests", "database pool"].map((name) => ({
          name,
          close: () => {
            attempted.push(name);
            if (["web", "test guests"].includes(name)) {
              throw new Error("credential-bearing-error-sentinel");
            }
          },
        })),
      ),
    ).rejects.toThrow(/^Browser test cleanup failed: web, test guests$/);
    expect(attempted).toEqual(["web", "API", "test guests", "database pool"]);
  });
});
