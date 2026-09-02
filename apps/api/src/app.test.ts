import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("system routes", () => {
  it("returns the shared liveness contract", async () => {
    const app = await createApp(async () => undefined);
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports ready only after the database probe succeeds", async () => {
    const app = await createApp(async () => undefined);
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("returns an unavailable contract without leaking the database error", async () => {
    const canary = "database-canary-secret";
    const app = await createApp(async () => {
      throw new Error(canary);
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.body).not.toContain(canary);
  });

  it("uses the safe error shape for unknown routes", async () => {
    const app = await createApp(async () => undefined);
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
    expect(response.json()).toHaveProperty("requestId");
  });

  it("allows only the configured web origin", async () => {
    const app = await createApp(async () => undefined);
    const allowed = await app.inject({
      headers: { origin: "http://localhost:5173" },
      method: "GET",
      url: "/health",
    });
    const rejected = await app.inject({
      headers: { origin: "http://127.0.0.1:5173" },
      method: "GET",
      url: "/health",
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

async function createApp(check: () => Promise<void>) {
  const app = await buildApp({
    logger: false,
    readiness: { check },
    webOrigin: "http://localhost:5173",
  });
  apps.push(app);
  return app;
}
