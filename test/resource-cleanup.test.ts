import { describe, expect, it } from "vitest";

import { attemptCleanup } from "./resource-cleanup.js";

describe("ordered resource cleanup", () => {
  it("waits for each stage and returns no failures after successful cleanup", async () => {
    const events: string[] = [];
    expect(
      await attemptCleanup([
        {
          name: "first",
          async close() {
            events.push("first");
            await Promise.resolve();
            events.push("first closed");
          },
        },
        {
          name: "second",
          close() {
            events.push("second");
          },
        },
      ]),
    ).toEqual([]);
    expect(events).toEqual(["first", "first closed", "second"]);
    expect(await attemptCleanup([])).toEqual([]);
  });

  it.each(["sync", "async", "both"])(
    "continues after %s failures and returns only failed stage names",
    async (mode) => {
      const events: string[] = [];
      const failed = await attemptCleanup([
        {
          name: "first",
          close() {
            events.push("first");
            if (mode !== "async") throw new Error("private-sync-sentinel");
          },
        },
        {
          name: "second",
          async close() {
            events.push("second");
            if (mode !== "sync") throw new Error("private-async-sentinel");
          },
        },
        {
          name: "last",
          close() {
            events.push("last");
          },
        },
      ]);
      expect(events).toEqual(["first", "second", "last"]);
      expect(failed).toEqual(
        mode === "both" ? ["first", "second"] : mode === "sync" ? ["first"] : ["second"],
      );
    },
  );
});
