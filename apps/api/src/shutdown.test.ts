import { afterEach, expect, it, vi } from "vitest";

import { createShutdown } from "./shutdown.js";

afterEach(() => vi.useRealTimers());

it("drains the server before closing the database and runs only once", async () => {
  const events: string[] = [];
  const drain = Promise.withResolvers<void>();
  const shutdown = createShutdown({
    async closeServer() {
      events.push("draining");
      await drain.promise;
      events.push("drained");
    },
    async closeDatabase() {
      events.push("database closed");
    },
    onTimeout() {
      events.push("timed out");
    },
  });
  const first = shutdown();
  const second = shutdown();
  expect(events).toEqual(["draining"]);
  drain.resolve();
  await Promise.all([first, second]);
  expect(events).toEqual(["draining", "drained", "database closed"]);
});

it("bounds stalled shutdown and clears its deadline after successful drain", async () => {
  vi.useFakeTimers();
  const drain = Promise.withResolvers<void>();
  let expired = false;
  const shutdown = createShutdown({
    closeServer: () => drain.promise,
    closeDatabase: async () => undefined,
    onTimeout() {
      expired = true;
    },
    timeoutMs: 20,
  });
  const closing = shutdown();
  await vi.advanceTimersByTimeAsync(20);
  expect(expired).toBe(true);
  drain.resolve();
  await closing;
  expect(vi.getTimerCount()).toBe(0);
});

it("closes the database even if server teardown fails", async () => {
  let databaseClosed = false;
  const shutdown = createShutdown({
    closeServer: async () => {
      throw new Error("fixture");
    },
    closeDatabase: async () => {
      databaseClosed = true;
    },
    onTimeout: () => undefined,
  });
  await expect(shutdown()).rejects.toThrow("fixture");
  expect(databaseClosed).toBe(true);
});
