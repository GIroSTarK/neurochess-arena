import {
  type ActionFunction,
  type LoaderFunction,
  type RouteObject,
  RouterContextProvider,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthApi } from "../api/auth-client";
import { RouteNavigation } from "../app/route-navigation";
import { RouteRuntime } from "../app/route-runtime";
import { createAppRoutes } from "../app/routes";
import {
  errorResponse,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
} from "../test/fixtures";
import { createHttpMock, type HttpRoutes } from "../test/http";

const session = {
  user: { id: GAME_ID, email: "private@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
const profile = { username: null, completed: false, avatar: { source: "initials", initials: "?" } };
const metadata = {
  credentialId: OTHER_GAME_ID,
  provider: "openai",
  label: "Arena",
  maskedSuffix: "1234",
  createdAt: "2026-10-01T00:00:00.000Z",
};
const save = {
  intent: "save",
  expectedAccount: GAME_ID,
  credentialId: OTHER_GAME_ID,
  save: "true",
  provider: "openai",
  label: "Arena",
  apiKey: "secret-canary-1234",
};
const clear = { intent: "clear", expectedAccount: GAME_ID, confirm: "true" };
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function find(routes: RouteObject[]): RouteObject | undefined {
  for (const route of routes) {
    if (route.id === "credentials") return route;
    const nested = route.children && find(route.children);
    if (nested) return nested;
  }
}
function harness(overrides: HttpRoutes = {}) {
  const http = createHttpMock({
    "GET /api/auth/get-session": () => jsonResponse(session),
    "GET /profile": () => jsonResponse(profile),
    "GET /credentials": () => jsonResponse({ credentials: [metadata] }),
    ...overrides,
  });
  vi.stubGlobal("fetch", http.fetch);
  const runtime = new RouteRuntime(createAuthApi("http://localhost:3001"));
  const route = find(
    createAppRoutes({
      apiBaseUrl: "http://localhost:3001",
      sandboxEnabled: false,
      runtime,
      navigation: new RouteNavigation(),
    }),
  )!;
  cleanups.push(() => {
    runtime.dispose();
    http.assertNoUnexpectedRequests();
  });
  const args = (request: Request) => ({
    request,
    params: {},
    context: new RouterContextProvider(),
    url: new URL(request.url),
    pattern: "/account/credentials",
  });
  const read = (signal = new AbortController().signal) =>
    (route.loader as LoaderFunction)(
      args(new Request("http://localhost/account/credentials", { signal })),
    );
  const submit = (input: Record<string, string>, signal = new AbortController().signal) => {
    expect(route.action, "Credential management owns its action").toBeTypeOf("function");
    return (route.action as ActionFunction)(
      args(
        new Request("http://localhost/account/credentials", {
          method: "POST",
          body: new URLSearchParams(input),
          signal,
        }),
      ),
    );
  };
  return { read, submit, runtime, http };
}

describe("credential route data", () => {
  it("loads masked metadata through account authority before onboarding without mutations", async () => {
    const { read, http } = harness();
    const result = await read();
    expect(result).toMatchObject({
      data: { access: "account", catalog: { phase: "ready", credentials: [metadata] } },
    });
    expect(JSON.stringify(result)).not.toMatch(/private@example|expiresAt|apiKey/);
    const reads = http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/credentials");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      headers: { "x-neurochess-expected-account": GAME_ID },
    });
  });
  it.each(["guest", "required", "unavailable"])(
    "gates %s reads and actions without guest bootstrap",
    async (access) => {
      if (access === "required") sessionStorage.setItem("neurochess.account-intent", "account");
      const { read, submit, http } = harness({
        "GET /api/auth/get-session": () => {
          if (access === "unavailable") throw new Error("private diagnostic");
          return jsonResponse(null);
        },
      });
      expect(await read()).toMatchObject({ data: { access, catalog: null } });
      expect(await submit(save)).toMatchObject({ data: { error: "CREDENTIAL_UNAUTHORIZED" } });
      expect(
        http.fetch.mock.calls.some(([url]) => requestPath(url).startsWith("/credentials")),
      ).toBe(false);
    },
  );
  it("saves only explicit opt-ins with the submitted UUID and returns a bounded acknowledgement", async () => {
    const { submit, http } = harness({
      "POST /credentials": (init) => {
        expect(JSON.parse(requestBody(init))).toEqual({
          credentialId: OTHER_GAME_ID,
          save: true,
          provider: "openai",
          label: "Arena",
          apiKey: "secret-canary-1234",
        });
        return jsonResponse(metadata, 201);
      },
    });
    const result = await submit(save);
    expect(result).toMatchObject({ data: { success: "saved" } });
    expect(JSON.stringify(result)).not.toContain("secret-canary");
    expect(http.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each([
    { ...save, save: "false" },
    { ...save, expectedAccount: OTHER_GAME_ID },
    { ...save, credentialId: "invalid" },
    { ...save, extra: "secret" },
    { ...clear, confirm: "false" },
    { intent: "revoke", credentialId: "invalid", expectedAccount: GAME_ID, confirm: "true" },
  ])("rejects invalid or stale mutation %j before dispatch", async (input) => {
    const { submit, http } = harness();
    expect(await submit(input)).toMatchObject({
      data: {
        error:
          input.expectedAccount === OTHER_GAME_ID
            ? "CREDENTIAL_UNAUTHORIZED"
            : "CREDENTIAL_INVALID_REQUEST",
      },
    });
    expect(http.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it.each(["revoke", "clear"])(
    "invalidates issued catalogs on confirmed %s and fences pre-mutation reads even when refresh fails",
    async (intent) => {
      const old = Promise.withResolvers<Response>();
      let reads = 0;
      const { read, submit } = harness({
        "GET /credentials": () => {
          reads++;
          if (reads === 2) return old.promise;
          if (reads > 2) throw new Error("refresh failed");
          return jsonResponse({ credentials: [metadata] });
        },
        [`POST /credentials/${intent}`]: () => jsonResponse({ status: "deleted" }),
      });
      const issued = await read();
      const pending = read();
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(
        await submit(
          intent === "clear" ? clear : { ...clear, intent, credentialId: OTHER_GAME_ID },
        ),
      ).toMatchObject({ data: { success: intent === "clear" ? "cleared" : "revoked" } });
      expect(JSON.stringify(issued)).not.toContain("Arena");
      old.resolve(jsonResponse({ credentials: [metadata] }));
      expect(JSON.stringify(await pending)).not.toContain("Arena");
      expect(await read()).toMatchObject({
        data: { catalog: { phase: "error", credentials: [] } },
      });
    },
  );
  it("keeps failed writes unconfirmed with no automatic retry or generated replacement ID", async () => {
    const { submit, http } = harness({
      "POST /credentials": () => {
        throw new Error("secret-canary-1234");
      },
    });
    const result = await submit(save);
    expect(result).toMatchObject({ data: { error: "CREDENTIAL_UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain("secret-canary");
    expect(http.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("clears loader and action references on account switching and fences a late metadata read", async () => {
    let switched = false;
    let reads = 0;
    const old = Promise.withResolvers<Response>();
    const { read, submit, runtime } = harness({
      "GET /api/auth/get-session": () =>
        jsonResponse(
          switched ? { ...session, user: { ...session.user, id: OTHER_GAME_ID } } : session,
        ),
      "GET /credentials": () =>
        ++reads === 1 ? jsonResponse({ credentials: [metadata] }) : old.promise,
      "POST /credentials": () => errorResponse("CREDENTIAL_CONFLICT", 409),
    });
    const issued = await read();
    const action = await submit(save);
    const pending = read();
    await vi.waitFor(() => expect(reads).toBe(2));
    switched = true;
    await runtime.account.refresh();
    expect(issued).toMatchObject({ data: null });
    expect(action).toMatchObject({ data: null });
    old.resolve(jsonResponse({ credentials: [metadata] }));
    expect(JSON.stringify(await pending)).not.toContain("Arena");
  });
  it("does not dispatch after cancellation during identity resolution", async () => {
    const abort = new AbortController();
    const { submit, runtime, http } = harness();
    await runtime.resolvePublicIdentity(new AbortController().signal, false);
    const resolve = runtime.resolvePublicIdentity.bind(runtime);
    vi.spyOn(runtime, "resolvePublicIdentity").mockImplementation(async (...args) => {
      const identity = await resolve(...args);
      abort.abort();
      return identity;
    });
    await submit(clear, abort.signal);
    expect(http.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
