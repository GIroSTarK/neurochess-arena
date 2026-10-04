import {
  createMemoryRouter,
  type LoaderFunction,
  type RouteObject,
  RouterContextProvider,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppRouter } from "../app/router";
import {
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock } from "../test/http";

import { readAuthEntry } from "./navigation";

const session = {
  user: { id: GAME_ID, email: "private@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
const profile = {
  username: "Player",
  completed: true,
  avatar: { source: "initials", initials: "PL" },
};
const routers: ReturnType<typeof createAppRouter>[] = [];
function setup(
  path = "/auth/sign-in",
  entry = readAuthEntry(new URL(path, "https://arena.invalid"), true),
) {
  const router = createAppRouter(
    { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false, authEntry: entry },
    (routes) => createMemoryRouter(routes, { initialEntries: [path.split("#")[0]!] }),
  );
  routers.push(router);
  return router;
}
function leaf(routes: RouteObject[], path: string): RouteObject {
  for (const route of routes) {
    if (route.path === path) return route;
    if (route.children) {
      const found = route.children
        .flatMap(function flatten(child): RouteObject[] {
          return [child, ...(child.children?.flatMap(flatten) ?? [])];
        })
        .find((child) => child.path === path);
      if (found) return found;
    }
  }
  throw new Error("Missing route");
}
const form = (values: Record<string, string | undefined>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) data.set(name, value);
  }
  return data;
};
const cached = (router: ReturnType<typeof setup>) =>
  JSON.stringify({
    loaders: router.state.loaderData,
    actions: router.state.actionData,
    fetchers: [...router.state.fetchers],
    location: router.state.location,
  });
afterEach(() => {
  for (const router of routers) router.dispose();
  routers.length = 0;
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("public route data", () => {
  it("loads the private profile and updates it through a guarded action without changing identity", async () => {
    let current = profile;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(current),
      "POST /profile": (init) => {
        expect(new Headers(init?.headers).get("x-neurochess-expected-account")).toBe(GAME_ID);
        expect(JSON.parse(requestBody(init))).toEqual({ username: "Renamed" });
        current = { ...profile, username: "Renamed" };
        return jsonResponse(current);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const router = setup("/account");
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    const before: unknown = router.state.loaderData.account;
    expect(before).toMatchObject({ data: { profile } });
    await router.navigate("/account", {
      formMethod: "post",
      formData: form({ intent: "save-profile", username: " Renamed ", expectedAccount: GAME_ID }),
    });
    expect(router.state.actionData?.account).toMatchObject({ data: { notice: "saved" } });
    expect(router.state.loaderData.account).toMatchObject({
      generation: (before as { generation: number }).generation,
      data: { profile: { username: "Renamed" } },
    });
    expect(cached(router)).not.toMatch(/private@example|expiresAt/);
    http.assertNoUnexpectedRequests();
  });

  it("completes onboarding through its action and replaces with the allowlisted game path", async () => {
    let completed = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () =>
        jsonResponse(completed ? profile : { ...profile, username: null, completed: false }),
      "POST /profile/onboarding": () => {
        completed = true;
        return jsonResponse(profile);
      },
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: snapshot(), configuration: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const path = `/account?returnTo=${encodeURIComponent(`/games/${GAME_ID}`)}`;
    const router = setup(path);
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    await router.navigate(path, {
      formMethod: "post",
      formData: form({ intent: "save-profile", username: "Player", expectedAccount: GAME_ID }),
    });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/games/${GAME_ID}`));
    expect(router.state.historyAction).toBe("REPLACE");
    http.assertNoUnexpectedRequests();
  });

  it("removes only the imported avatar through its distinct action", async () => {
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "POST /profile": (init) => {
        expect(JSON.parse(requestBody(init))).toEqual({ avatar: "remove" });
        return jsonResponse(profile);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const router = setup("/account");
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    await router.navigate("/account", {
      formMethod: "post",
      formData: form({ intent: "remove-avatar", expectedAccount: GAME_ID }),
    });
    expect(router.state.actionData?.account).toMatchObject({ data: { notice: "saved" } });
    http.assertNoUnexpectedRequests();
  });

  it.each([
    { intent: "save-profile", username: "Player", expectedAccount: OTHER_GAME_ID },
    { intent: "save-profile", username: "admin", expectedAccount: GAME_ID },
    { intent: "remove-avatar", avatar: "https://hostile.invalid", expectedAccount: GAME_ID },
    { intent: "delete-account", expectedAccount: GAME_ID },
    { intent: "delete-account", confirm: "true", expectedAccount: OTHER_GAME_ID },
  ])("rejects invalid or stale account mutation %j", async (input) => {
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
    });
    vi.stubGlobal("fetch", http.fetch);
    const router = setup("/account");
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    await router.fetch("profile", "account", "/account", {
      formMethod: "post",
      formData: form(input),
    });
    expect(http.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    http.assertNoUnexpectedRequests();
  });

  it("clears issued profile data as soon as confirmed deletion begins and never equates session loss with success", async () => {
    const pending = Promise.withResolvers<Response>();
    let exists = true;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(exists ? session : null),
      "GET /profile": () => jsonResponse({ ...profile, completed: false, username: null }),
      "POST /api/auth/delete-account": () => pending.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    const router = setup("/account");
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    const issued: unknown = router.state.loaderData.account;
    const operation = router.navigate("/account", {
      formMethod: "post",
      formData: form({ intent: "delete-account", confirm: "true", expectedAccount: GAME_ID }),
    });
    await vi.waitFor(() => expect(issued).toMatchObject({ data: null }));
    exists = false;
    pending.reject(new Error("secret diagnostic"));
    await operation;
    expect(router.state.actionData?.account).toMatchObject({ data: { error: "AUTH_UNAVAILABLE" } });
    expect(cached(router)).not.toMatch(/secret diagnostic|private@example|Player/);
    http.assertNoUnexpectedRequests();
  });

  it("keeps a bounded OAuth failure after its identity transition", async () => {
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "POST /api/auth/sign-in/social": () =>
        jsonResponse(
          { code: "AUTH_OAUTH_FAILED", message: "oauth-secret-canary", requestId: "test" },
          503,
        ),
    });
    vi.stubGlobal("fetch", http.fetch);
    const router = setup("/auth/sign-up");
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    await router.navigate("/auth/sign-up", {
      formMethod: "post",
      formData: form({ intent: "oauth", provider: "github" }),
    });
    expect(Object.values(router.state.actionData ?? {})).toContainEqual(
      expect.objectContaining({ data: { error: "AUTH_OAUTH_FAILED" } }),
    );
    expect(cached(router)).not.toContain("oauth-secret-canary");
    http.assertNoUnexpectedRequests();
  });

  it("does not sign out a replacement account when the submitted expectation is stale", async () => {
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
    });
    vi.stubGlobal("fetch", http.fetch);
    const router = setup("/account");
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    await router.navigate("/account", {
      formMethod: "post",
      formData: form({ intent: "sign-out", expectedAccount: OTHER_GAME_ID }),
    });
    expect(http.fetch.mock.calls.some(([url]) => requestPath(url) === "/api/auth/sign-out")).toBe(
      false,
    );
    http.assertNoUnexpectedRequests();
  });

  it("resolves identity even when a protected child loader runs without its parent", async () => {
    const pending = Promise.withResolvers<Response>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () => pending.promise.then((response) => response.clone()),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => jsonResponse({ credentials: [] }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const router = setup("/missing");
    expect(http.fetch).not.toHaveBeenCalled();
    const loader = leaf(router.routes, "account/credentials").loader;
    expect(loader).toBeTypeOf("function");
    const result = (loader as LoaderFunction)({
      request: new Request("https://arena.invalid/account/credentials"),
      params: {},
      context: new RouterContextProvider(),
      url: new URL("https://arena.invalid/account/credentials"),
      pattern: "/account/credentials",
    });
    await vi.waitFor(() => expect(http.fetch).toHaveBeenCalledOnce());
    pending.resolve(jsonResponse(session));
    await expect(result).resolves.toMatchObject({ data: { access: "account" } });
    expect(JSON.stringify(await result)).not.toMatch(/private@example|Player|expiresAt/);
    http.assertNoUnexpectedRequests();
  });

  it.each(["sign-up", "verify", "forgot-password"])(
    "uses the %s action for a generic acknowledgement",
    async (kind) => {
      const endpoints = {
        "sign-up": "sign-up/email",
        verify: "send-verification-email",
        "forgot-password": "request-password-reset",
      };
      const endpoint = endpoints[kind as keyof typeof endpoints];
      const http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(null),
        [`POST /api/auth/${endpoint}`]: () =>
          jsonResponse({ status: "accepted", message: "unsafe-response-canary" }),
      });
      vi.stubGlobal("fetch", http.fetch);
      const router = setup(`/auth/${kind}`);
      await vi.waitFor(() => expect(router.state.initialized).toBe(true));
      await router.navigate(`/auth/${kind}`, {
        formMethod: "post",
        formData: form({
          intent: kind,
          email: "player@example.com",
          password: "password-secret-canary",
        }),
      });
      expect(router.state.errors).toBeNull();
      expect(Object.values(router.state.actionData ?? {})).toContainEqual(
        expect.objectContaining({ data: { notice: "accepted" } }),
      );
      expect(cached(router)).not.toMatch(/password-secret|unsafe-response|player@example/);
      http.assertNoUnexpectedRequests();
    },
  );

  it("replaces sign-in with the canonical return path without putting credentials or return targets in result data", async () => {
    let signedIn = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(signedIn ? session : null),
      "GET /profile": () => jsonResponse(profile),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: snapshot(), configuration: null }),
      "POST /api/auth/sign-in/email": () => {
        signedIn = true;
        return jsonResponse({ success: true });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const path = `/games/${GAME_ID}`;
    const router = setup(`/auth/sign-in?returnTo=${encodeURIComponent(path)}`);
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    await router.navigate(router.state.location.pathname + router.state.location.search, {
      formMethod: "post",
      formData: form({
        intent: "sign-in",
        email: "player@example.com",
        password: "password-secret-canary",
      }),
    });
    expect(router.state.location.pathname).toBe(path);
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.loaderData["arena-game"]).toMatchObject({
      data: { entry: { kind: "game", gameId: GAME_ID } },
    });
    expect(
      JSON.stringify([
        router.state.loaderData,
        router.state.actionData,
        router.state.location.state,
      ]),
    ).not.toMatch(/password-secret|returnTo|private@example/);
    http.assertNoUnexpectedRequests();
  });

  it("reads the reset token only inside the action and requires explicit sign-in afterward", async () => {
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "POST /api/auth/reset-password": () => jsonResponse({ success: true }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const entry = readAuthEntry(
      new URL("https://arena.invalid/auth/reset-password#token=reset-secret-canary"),
      true,
    );
    const read = vi.spyOn(entry, "readResetToken");
    const router = setup("/auth/reset-password", entry);
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    expect(read).not.toHaveBeenCalled();
    await router.navigate("/auth/reset-password", {
      formMethod: "post",
      formData: form({ intent: "reset-password", password: "new-password-canary" }),
    });
    expect(read).toHaveBeenCalledOnce();
    expect(entry.readResetToken()).toBeNull();
    const sent = http.fetch.mock.calls.find(
      ([url]) => requestPath(url) === "/api/auth/reset-password",
    );
    expect(requestBody(sent?.[1])).toBe(
      JSON.stringify({ token: "reset-secret-canary", newPassword: "new-password-canary" }),
    );
    expect(router.state.location.pathname).toBe("/auth/reset-password");
    expect(Object.values(router.state.actionData ?? {})).toContainEqual(
      expect.objectContaining({ data: { notice: "resetDone" } }),
    );
    expect(cached(router)).not.toMatch(/reset-secret|new-password/);
    http.assertNoUnexpectedRequests();
  });
});
