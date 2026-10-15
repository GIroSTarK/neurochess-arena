import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import type { Principal } from "../identity/principal.js";

import { enforcePrincipalLimit } from "./http.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("HTTP abuse policy", () => {
  it("rejects discovery before work, partitions verified identities behind a NAT, and preserves recovery", async () => {
    let now = 0;
    const app = await buildApp({
      webOrigin: "https://arena.example.com",
      readiness: { check: async () => undefined },
      requestLimits: {
        now: () => now,
        policies: { discovery: { ip: 10, principal: 2, inFlight: 4 } },
      },
    });
    apps.push(app);
    let principal: Principal = { kind: "guest", guestSessionId: randomUUID() };
    const work = vi.fn();
    for (const path of [
      "/providers/models",
      "/games/:gameId/controller",
      "/games/:gameId/lifecycle",
    ]) {
      app.post(path, async (request) => {
        enforcePrincipalLimit(request, principal);
        work();
        return { status: "ok" };
      });
    }
    const discover = () =>
      app.inject({
        method: "POST",
        url: "/providers/models",
        payload: { apiKey: "private-key" },
        headers: { "x-forwarded-for": randomUUID() },
      });
    expect((await discover()).statusCode).toBe(200);
    expect((await discover()).statusCode).toBe(200);
    const rejected = await discover();
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("60");
    expect(rejected.headers["cache-control"]).toBe("no-store");
    expect(rejected.body).not.toContain("private-key");
    expect(work).toHaveBeenCalledTimes(2);
    for (const action of ["controller", "lifecycle"]) {
      expect(
        (await app.inject({ method: "POST", url: `/games/${randomUUID()}/${action}` })).statusCode,
      ).toBe(200);
    }
    principal = { kind: "guest", guestSessionId: randomUUID() };
    expect((await discover()).statusCode).toBe(200);
    now = 60_000;
    expect((await discover()).statusCode).toBe(200);
  });

  it("limits before parsing or authentication, including forged addresses", async () => {
    const app = await buildApp({
      webOrigin: "https://arena.example.com",
      readiness: { check: async () => undefined },
      requestLimits: { policies: { bootstrap: { ip: 2, principal: 2, inFlight: 2 } } },
    });
    apps.push(app);
    const bootstrap = vi.fn(async () => ({ status: "ready" }));
    app.post("/guest-session", bootstrap);
    for (let i = 0; i < 2; i++) {
      expect((await app.inject({ method: "POST", url: "/guest-session" })).statusCode).toBe(200);
    }
    const response = await app.inject({
      method: "POST",
      url: "/guest-session",
      payload: "{private-key",
      headers: {
        origin: "https://arena.example.com",
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.99",
      },
    });
    expect(response.statusCode).toBe(429);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(response.headers["access-control-expose-headers"]).toContain("Retry-After");
  });

  it("bounds pending upstream work and releases capacity on completion", async () => {
    const app = await buildApp({
      webOrigin: "https://arena.example.com",
      readiness: { check: async () => undefined },
      requestLimits: { policies: { discovery: { ip: 100, principal: 20, inFlight: 1 } } },
    });
    apps.push(app);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    app.post("/providers/models", async () => {
      entered.resolve();
      await finish.promise;
      return {};
    });
    const first = app.inject({ method: "POST", url: "/providers/models" });
    await entered.promise;
    try {
      const limited = await app.inject({
        method: "POST",
        url: "/providers/models",
        remoteAddress: "192.0.2.6",
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("1");
    } finally {
      finish.resolve();
    }
    expect((await first).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/providers/models" })).statusCode).toBe(200);
  });
});
