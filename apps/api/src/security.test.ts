import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("API response security", () => {
  it("protects successful, rejected, unavailable and preflight responses", async () => {
    const app = await buildApp({
      webOrigin: "https://arena.example.com",
      readiness: {
        check: async () => {
          throw new Error("private-database-canary");
        },
      },
    });
    apps.push(app);
    for (const input of [
      { method: "GET" as const, url: "/health", status: 200 },
      { method: "GET" as const, url: "/ready", status: 503 },
      { method: "GET" as const, url: "/missing?token=private-callback-canary", status: 404 },
      {
        method: "OPTIONS" as const,
        url: "/health",
        status: 204,
        headers: {
          origin: "https://arena.example.com",
          "access-control-request-method": "GET",
        },
      },
    ]) {
      const response = await app.inject(input);
      expect(response.statusCode).toBe(input.status);
      expect(response.headers).toMatchObject({
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        "cross-origin-resource-policy": "same-site",
      });
      expect(response.body).not.toContain("canary");
      expect(response.headers["cross-origin-embedder-policy"]).toBeUndefined();
    }
  });

  it("keeps early proxy rejection private before CORS or route admission", async () => {
    const app = await buildApp({
      webOrigin: "https://arena.example.com",
      trustedProxyIp: "127.0.0.1",
      readiness: { check: async () => undefined },
    });
    apps.push(app);
    const response = await app.inject({ url: "/health", remoteAddress: "127.0.0.1" });
    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});
