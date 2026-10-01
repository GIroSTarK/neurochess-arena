import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const webOrigin = "http://localhost:5173";
const baseURL = "http://localhost:3001";

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(handle: (request: Request) => Promise<Response>, emailEnabled = false) {
  const app = await buildApp({
    readiness: { check: async () => undefined },
    webOrigin,
    auth: { baseURL, handle, emailEnabled, resolve: async () => null },
  });
  apps.push(app);
  return app;
}

describe("auth HTTP bridge", () => {
  it("sends invalid browser verification links to a token-free localized recovery page, retaining JSON errors", async () => {
    const app = await createApp(
      async () =>
        Response.json({ code: "TOKEN_EXPIRED", message: "secret-canary" }, { status: 400 }),
      true,
    );
    for (const url of [
      "/api/auth/verify-email?token=secret-canary",
      "/api/auth/verify-email?unexpected=secret-canary",
    ]) {
      const browser = await app.inject({ url, headers: { accept: "text/html" } });
      expect(browser.statusCode).toBe(303);
      expect(browser.headers.location).toBe(
        webOrigin + "/?auth=verification-error&code=AUTH_INVALID_TOKEN",
      );
      expect(browser.body).not.toContain("canary");
      expect(browser.headers["referrer-policy"]).toBe("no-referrer");
      const api = await app.inject({ url, headers: { accept: "application/json" } });
      expect(api.statusCode).toBe(400);
      expect(api.headers.location).toBeUndefined();
    }
  });
  it("projects the session and preserves each Set-Cookie header, including Expires commas", async () => {
    const cookies = [
      "first=one; Path=/; HttpOnly; Secure; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      "second=two; Path=/; HttpOnly; Secure; SameSite=Lax",
    ];
    const app = await createApp(async () => {
      const headers = new Headers({ "content-type": "application/json" });
      for (const cookie of cookies) headers.append("set-cookie", cookie);
      return new Response(
        JSON.stringify({
          user: {
            id: "1b613567-f794-465a-a902-165acb8b4e35",
            email: "fixture@example.com",
            emailVerified: true,
            name: "untrusted-name",
            image: "untrusted-image",
          },
          session: {
            token: "session-token-canary",
            ipAddress: "private-ip",
            expiresAt: "2026-10-21T00:00:00.000Z",
          },
        }),
        { headers },
      );
    });
    const response = await app.inject({ url: "/api/auth/get-session" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: "1b613567-f794-465a-a902-165acb8b4e35",
        email: "fixture@example.com",
        emailVerified: true,
      },
      session: { expiresAt: "2026-10-21T00:00:00.000Z" },
    });
    expect(response.headers["set-cookie"]).toEqual(cookies);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("preserves failure status and retry headers while replacing raw library errors", async () => {
    const app = await createApp(
      async () =>
        new Response(JSON.stringify({ message: "secret-canary", token: "token-canary" }), {
          status: 429,
          headers: { "X-Retry-After": "60" },
        }),
    );
    const response = await app.inject({ url: "/api/auth/get-session" });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.json()).toMatchObject({
      code: "AUTH_RATE_LIMITED",
      message: "Too many authentication requests. Try again later.",
    });
    expect(response.body).not.toContain("canary");
  });

  it("uses the configured origin and socket IP instead of client host/forwarding headers", async () => {
    let received: Request | undefined;
    const app = await createApp(async (request) => {
      received = request;
      return Response.json(null);
    });
    await app.inject({
      url: "/api/auth/get-session",
      remoteAddress: "192.0.2.13",
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "192.0.2.99",
        "x-neurochess-client-ip": "192.0.2.99",
      },
    });
    expect(received?.url).toBe(`${baseURL}/api/auth/get-session`);
    expect(received?.headers.get("x-neurochess-client-ip")).toBe("192.0.2.13");
    expect(received?.headers.get("x-forwarded-for")).toBeNull();
    expect(received?.headers.get("x-forwarded-host")).toBeNull();
  });

  it.each([
    {
      method: "GET" as const,
      url: "/api/auth/get-session",
      headers: { origin: "https://attacker.example" },
      status: 403,
    },
    { method: "POST" as const, url: "/api/auth/sign-out", headers: {}, payload: {}, status: 403 },
    {
      method: "POST" as const,
      url: "/api/auth/sign-out",
      headers: { origin: webOrigin },
      payload: { callbackURL: "https://attacker.example" },
      status: 400,
    },
    { method: "GET" as const, url: "/api/auth/get-session?userId=forged", status: 400 },
    { method: "POST" as const, url: "/api/auth/sign-up/email", payload: {}, status: 404 },
    { method: "POST" as const, url: "/api/auth/delete-user", payload: {}, status: 404 },
    { method: "GET" as const, url: "/api/auth/list-sessions", status: 404 },
    { method: "GET" as const, url: "/api/auth/error?error=secret-canary", status: 404 },
  ])(
    "rejects unsupported or untrusted input before invoking auth: $url",
    async ({ status, ...request }) => {
      let calls = 0;
      const app = await createApp(async () => {
        calls++;
        return Response.json(null);
      });
      const response = await app.inject(request);
      expect(response.statusCode).toBe(status);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("secret-canary");
      expect(calls).toBe(0);
    },
  );

  it("sanitizes thrown errors and malformed session responses", async () => {
    for (const handle of [
      async () => {
        throw new Error("auth-secret-canary");
      },
      async () =>
        Response.json({ user: { id: "forged" }, session: { token: "auth-secret-canary" } }),
    ]) {
      const app = await createApp(handle);
      const response = await app.inject({ url: "/api/auth/get-session" });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
      expect(response.body).not.toContain("canary");
    }
  });
});
