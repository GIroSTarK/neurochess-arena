import { randomUUID } from "node:crypto";

import type { ModelDiscoveryRequest, ModelDiscoveryResult } from "@neurochess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { GameRequestError } from "../games/errors.js";
import { GUEST_COOKIE_NAME, type GuestService } from "../guests/service.js";
import type { Principal } from "../identity/principal.js";

import type { ProviderModelService } from "./model-service.js";

const webOrigin = "http://localhost:5173";
const apiKey = "standalone-discovery-key-canary";
const principal = { kind: "guest", guestSessionId: randomUUID() } as const;
const token = "g".repeat(43);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function standalone(
  models: ProviderModelService = async () => ({ ok: true, models: [] }),
  discoveryTimeoutMs?: number,
) {
  const bootstrap = vi.fn<GuestService["bootstrap"]>();
  const authenticate = vi.fn<GuestService["authenticate"]>(async (value) => {
    if (value !== token) throw new GameRequestError("UNAUTHORIZED");
    return { principal, token };
  });
  const dispatch = vi.fn(models);
  const app = await buildApp({
    readiness: { check: async () => undefined },
    webOrigin,
    providerApi: {
      models: dispatch,
      guests: { ttlSeconds: 3600, bootstrap, authenticate },
      ...(discoveryTimeoutMs === undefined ? {} : { discoveryTimeoutMs }),
    },
  });
  apps.push(app);
  let body: ModelDiscoveryRequest | undefined;
  app.addHook("preHandler", async (request) => {
    body = request.body as ModelDiscoveryRequest;
  });
  const post = (
    options: {
      payload?: object;
      url?: string;
      headers?: Record<string, string | undefined>;
    } = {},
  ) =>
    app.inject({
      method: "POST",
      url: options.url ?? "/providers/models",
      payload: options.payload ?? { provider: "openai", apiKey },
      headers: Object.fromEntries(
        Object.entries({
          origin: webOrigin,
          cookie: `${GUEST_COOKIE_NAME}=${token}`,
          ...options.headers,
        } as Record<string, string | undefined>).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
  return { app, post, dispatch, bootstrap, authenticate, body: () => body };
}

describe("standalone provider routes", () => {
  it("registers discovery without game routes and clears the request key after success", async () => {
    const api = await standalone();
    const response = await api.post();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, models: [] });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain(apiKey);
    const [identity, provider, access] = api.dispatch.mock.calls[0]!;
    expect(identity).toEqual(principal);
    expect(provider).toBe("openai");
    expect(access).toHaveProperty("apiKey", apiKey);
    expect(access.signal).toBeInstanceOf(AbortSignal);
    expect(api.body()).toEqual({ provider: "openai", apiKey: "" });
    expect(api.bootstrap).not.toHaveBeenCalled();
    expect((await api.app.inject({ url: "/games/unfinished" })).statusCode).toBe(404);
  });

  it("passes saved references without adding a plaintext key", async () => {
    const api = await standalone();
    const credentialId = randomUUID();
    expect((await api.post({ payload: { provider: "google", credentialId } })).statusCode).toBe(
      200,
    );
    const [identity, provider, access] = api.dispatch.mock.calls[0]!;
    expect(identity).toEqual(principal);
    expect(provider).toBe("google");
    expect(access).toHaveProperty("credentialId", credentialId);
    expect(access).not.toHaveProperty("apiKey");
    expect(access.signal).toBeInstanceOf(AbortSignal);
    expect(api.body()).toEqual({ provider: "google", credentialId });
  });

  it.each([
    { provider: "unknown", apiKey },
    { provider: "openai" },
    { provider: "openai", apiKey: "" },
    { provider: "openai", apiKey, credentialId: randomUUID() },
    { provider: "openai", credentialId: "invalid" },
    { provider: "openai", apiKey, extra: true },
  ])("rejects an invalid body before identity or provider work: %j", async (payload) => {
    const api = await standalone();
    const response = await api.post({ payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(api.dispatch).not.toHaveBeenCalled();
    expect(api.authenticate).not.toHaveBeenCalled();
    expect(api.bootstrap).not.toHaveBeenCalled();
  });

  it("rejects query fields before identity or provider work", async () => {
    const api = await standalone();
    const response = await api.post({ url: "/providers/models?extra=true" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(api.dispatch).not.toHaveBeenCalled();
    expect(api.authenticate).not.toHaveBeenCalled();
    expect(api.bootstrap).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://untrusted.example"])(
    "rejects Origin %s before identity or dispatch",
    async (origin) => {
      const api = await standalone();
      const response = await api.post({ headers: { origin } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(api.dispatch).not.toHaveBeenCalled();
      expect(api.authenticate).not.toHaveBeenCalled();
      expect(api.bootstrap).not.toHaveBeenCalled();
    },
  );

  it.each([
    { headers: { cookie: "" }, status: 401, code: "UNAUTHORIZED" },
    { headers: { cookie: `${GUEST_COOKIE_NAME}=forged` }, status: 401, code: "UNAUTHORIZED" },
    { headers: { "x-neurochess-identity": "account" }, status: 401, code: "UNAUTHORIZED" },
    { headers: { "x-neurochess-identity": "invalid" }, status: 400, code: "INVALID_REQUEST" },
    {
      headers: { "x-neurochess-expected-account": randomUUID() },
      status: 401,
      code: "UNAUTHORIZED",
    },
    {
      headers: { "x-neurochess-expected-account": "invalid" },
      status: 400,
      code: "INVALID_REQUEST",
    },
  ])(
    "rejects invalid identity without dispatch or bootstrap: $headers",
    async ({ headers, status, code }) => {
      const api = await standalone();
      const response = await api.post({ headers });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(api.dispatch).not.toHaveBeenCalled();
      expect(api.bootstrap).not.toHaveBeenCalled();
    },
  );

  it.each(["failure", "exception"] as const)(
    "clears the request key after a provider %s",
    async (outcome) => {
      const api = await standalone(async () => {
        if (outcome === "exception") throw new GameRequestError("UNAUTHORIZED");
        return { ok: false, error: { code: "provider_auth" } };
      });
      const response = await api.post();
      expect(response.statusCode).toBe(outcome === "exception" ? 401 : 200);
      expect(response.json()).toMatchObject(
        outcome === "exception"
          ? { code: "UNAUTHORIZED" }
          : { ok: false, error: { code: "provider_auth" } },
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(api.body()).toEqual({ provider: "openai", apiKey: "" });
      expect(response.body).not.toContain(apiKey);
    },
  );

  it("cancels discovery at its own deadline and clears the request key", async () => {
    let signal: AbortSignal | undefined;
    const api = await standalone(async (_principal: Principal, _provider, access) => {
      signal = access.signal;
      return new Promise<ModelDiscoveryResult>((resolve) => {
        access.signal.addEventListener(
          "abort",
          () =>
            resolve({
              ok: false,
              error: { code: "provider_timeout" },
            }),
          { once: true },
        );
      });
    }, 10);
    const response = await api.post();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, error: { code: "provider_timeout" } });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(DOMException);
    expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(api.body()).toEqual({ provider: "openai", apiKey: "" });
  });
});
