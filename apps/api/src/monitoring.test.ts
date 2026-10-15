import { operationsSnapshotSchema } from "@neurochess/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createOperations } from "./monitoring/operations.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("private operational signals", () => {
  it("keeps liveness and gameplay HTTP available when sampling fails", async () => {
    const app = await buildApp({
      readiness: {
        async check() {
          return undefined;
        },
      },
      webOrigin: "http://localhost:5173",
      operations: {
        ...createOperations(),
        snapshot() {
          throw new Error("private-sampler-canary");
        },
      },
    });
    apps.push(app);
    expect((await app.inject("/internal/operations")).statusCode).toBe(503);
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject("/ready")).statusCode).toBe(200);
  });
  it("reports database failure and recovery without retaining private request content", async () => {
    let available = true;
    const app = await buildApp({
      readiness: {
        async check() {
          if (!available) throw new Error("private-db-canary");
        },
      },
      webOrigin: "http://localhost:5173",
    });
    apps.push(app);
    app.get("/failure/:gameId", () => {
      throw new Error("private-error-canary");
    });
    await app.inject("/failure/private-game-canary?token=private-token-canary");
    await app.inject("/unknown/private-path-canary");
    available = false;
    const failed = await app.inject("/internal/operations");
    expect(failed.statusCode).toBe(200);
    expect(failed.headers["cache-control"]).toBe("no-store");
    expect(failed.json()).toMatchObject({
      protocol: 1,
      counters: { httpServerFailures: 1, httpRejected: 1 },
      gauges: { databaseReady: 0 },
    });
    expect(failed.body).not.toContain("canary");
    available = true;
    const recovered = await app.inject("/internal/operations");
    expect(operationsSnapshotSchema.parse(recovered.json()).gauges.databaseReady).toBe(1);
    expect(operationsSnapshotSchema.parse(recovered.json()).counters.httpServerFailures).toBe(1);
  });

  it("denies proxy and forwarded loopback access to operational data", async () => {
    const app = await buildApp({
      readiness: {
        async check() {
          return undefined;
        },
      },
      webOrigin: "https://arena.example.com",
      trustedProxyIp: "172.30.0.2",
    });
    apps.push(app);
    for (const remoteAddress of ["172.30.0.2", "192.0.2.1"]) {
      const response = await app.inject({
        url: "/internal/operations",
        remoteAddress,
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("counters");
    }
    const browser = await app.inject({
      url: "/internal/operations",
      headers: { origin: "https://arena.example.com" },
    });
    expect(browser.statusCode).toBe(404);
  });
});
