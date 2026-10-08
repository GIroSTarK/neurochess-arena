import { createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppRouter } from "../app/router";
import { readAuthEntry } from "../auth/navigation";
import {
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock } from "../test/http";

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

describe("profile route data", () => {
  it.each(["intent", "expectedAccount", "username"])(
    "rejects duplicate %s fields before changing the profile",
    async (field) => {
      const http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(session),
        "GET /profile": () => jsonResponse(profile),
      });
      vi.stubGlobal("fetch", http.fetch);
      const router = setup("/account");
      await vi.waitFor(() => expect(router.state.initialized).toBe(true));
      const input = form({ intent: "save-profile", expectedAccount: GAME_ID, username: "Player" });
      input.append(field, input.get(field)!);
      await router.navigate("/account", { formMethod: "post", formData: input });
      expect(router.state.actionData?.account).toMatchObject({
        data: { error: "AUTH_INVALID_REQUEST" },
      });
      expect(http.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
      http.assertNoUnexpectedRequests();
    },
  );

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
});
