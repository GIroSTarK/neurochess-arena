import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { AUTH_IP_HEADER } from "../auth/constants.js";

import { ipBudgetKey, normalizedIp } from "./proxy.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("verified proxy boundary", () => {
  it("merges equivalent addresses and IPv6 privacy addresses without merging IPv4 clients", () => {
    expect(normalizedIp("::ffff:c000:201")).toBe("192.0.2.1");
    expect(ipBudgetKey("2001:db8:0:1::abcd")).toBe(ipBudgetKey("2001:0db8:0000:0001:ffff::1"));
    expect(ipBudgetKey("2001:db8:0:2::1")).not.toBe(ipBudgetKey("2001:db8:0:1::1"));
    expect(ipBudgetKey("192.0.2.1")).not.toBe(ipBudgetKey("192.0.2.2"));
  });
  async function setup() {
    const handle = vi.fn<(request: Request) => Promise<Response>>(async () => Response.json(null));
    const app = await buildApp({
      readiness: { check: async () => undefined },
      webOrigin: "https://arena.example.com",
      trustedProxyIp: "172.30.0.2",
      auth: { baseURL: "https://api.example.com", handle, resolve: async () => null },
    });
    apps.push(app);
    return { app, handle };
  }

  it("passes only the single IP from the configured direct proxy to auth", async () => {
    const { app, handle } = await setup();
    const response = await app.inject({
      url: "/api/auth/get-session",
      remoteAddress: "::ffff:172.30.0.2",
      headers: {
        "x-forwarded-for": "2001:db8:0:0::1",
        "x-neurochess-client-ip": "192.0.2.99",
        "x-forwarded-host": "attacker.example",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(handle.mock.calls[0]?.[0].headers.get(AUTH_IP_HEADER)).toBe("2001:db8::1");
    expect(handle.mock.calls[0]?.[0].url).toBe("https://api.example.com/api/auth/get-session");
  });

  it.each([undefined, "192.0.2.1, 192.0.2.2", "not-an-ip", "fe80::1%eth0"])(
    "rejects missing, chained or malformed forwarding from the trusted peer before auth",
    async (forwarded) => {
      const { app, handle } = await setup();
      const response = await app.inject({
        url: "/api/auth/get-session",
        remoteAddress: "172.30.0.2",
        headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
      });
      expect(response.statusCode).toBe(400);
      expect(handle).not.toHaveBeenCalled();
    },
  );

  it("ignores all forwarding assertions from an untrusted peer", async () => {
    const { app, handle } = await setup();
    await app.inject({
      url: "/api/auth/get-session",
      remoteAddress: "192.0.2.4",
      headers: { "x-forwarded-for": "172.30.0.2", forwarded: "for=192.0.2.99" },
    });
    expect(handle.mock.calls[0]?.[0].headers.get(AUTH_IP_HEADER)).toBe("192.0.2.4");
  });
});
