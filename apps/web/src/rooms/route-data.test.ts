import { createMemoryRouter, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthApi } from "../api/auth-client";
import { RouteNavigation } from "../routing/route-navigation";
import { RouteRuntime } from "../routing/route-runtime";
import { GAME_ID, jsonResponse, requestBody, requestPath } from "../test/fixtures";
import { createHttpMock, type HttpRoutes } from "../test/http";
import { INVITATION, joinedRoom, roomProfile, roomSession, waitingRoom } from "../test/rooms";

import { consumeRoomInvitation } from "./invitation";
import { roomRouteData } from "./route-data";

const cleanups: (() => void)[] = [];
function setup(path = "/rooms", routes: HttpRoutes = {}, account = true) {
  window.history.replaceState(null, "", path);
  const entry = consumeRoomInvitation();
  const http = createHttpMock({
    "GET /api/auth/get-session": () => jsonResponse(account ? roomSession : null),
    "GET /profile": () => jsonResponse(roomProfile),
    "GET /games/unfinished": () => jsonResponse({ game: null }),
    "POST /rooms/invitations/resolve": () => jsonResponse({ status: "joinable" }),
    ...routes,
  });
  vi.stubGlobal("fetch", http.fetch);
  const runtime = new RouteRuntime(createAuthApi("http://localhost:3001"));
  const navigation = new RouteNavigation();
  const feature = roomRouteData(
    { apiBaseUrl: "http://localhost:3001", runtime, navigation },
    entry,
  );
  const router = createMemoryRouter(
    [
      { path: "/rooms", ...feature.setup },
      { path: "/rooms/join", ...feature.join },
      { path: "/games/:gameId", ...feature.waiting },
      { path: "*" },
    ],
    { initialEntries: [window.location.pathname] },
  );
  const unsubscribe = router.subscribe((state) => {
    runtime.navigating(state.navigation.location ?? state.location);
    navigation.departing(state.navigation.location ?? state.location);
  });
  cleanups.push(() => {
    unsubscribe();
    router.dispose();
    feature.dispose();
    runtime.dispose();
    http.assertNoUnexpectedRequests();
  });
  const submit = async (intent: string, extra: Record<string, string> = {}) => {
    const formData = new FormData();
    for (const [key, value] of Object.entries({
      intent,
      generation: String(runtime.account.getSnapshot().revision),
      expectedIdentity: account ? roomSession.user.id : "guest",
      ...extra,
    })) {
      formData.set(key, value);
    }
    await router.navigate(router.state.location.pathname, { formMethod: "post", formData });
  };
  return { feature, runtime, router, http, submit, navigation };
}
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
const ready = async (router: ReturnType<typeof setup>["router"]) =>
  vi.waitFor(() => expect(router.state.initialized).toBe(true));

describe("room entry route data", () => {
  it("retains an accepted join command through rate-limited acknowledgement recovery", async () => {
    let attempt = 0;
    const { router, feature, http, submit } = setup(
      `/rooms/join#invite=${INVITATION}`,
      {
        "POST /guest-session": () => jsonResponse({ status: "ready" }),
        "POST /rooms/join": () => {
          attempt++;
          if (attempt === 1) throw new Error("lost acknowledgement");
          if (attempt === 2) {
            return jsonResponse({ code: "RATE_LIMITED", message: "safe", requestId: "test" }, 429);
          }
          return jsonResponse(joinedRoom());
        },
      },
      false,
    );
    await ready(router);
    await submit("join");
    await submit("retry-join");
    expect(feature.memory.getSnapshot()).toMatchObject({ issue: "limited", pending: "join" });
    await submit("retry-join");
    expect(router.state.location.pathname).toBe(`/games/${GAME_ID}`);
    const requests = http.fetch.mock.calls
      .filter(([url]) => requestPath(url) === "/rooms/join")
      .map(([, init]) => requestBody(init));
    expect(requests).toHaveLength(3);
    expect(new Set(requests).size).toBe(1);
  });
  it("coalesces simultaneous create actions before issuing a server operation", async () => {
    const operation = Promise.withResolvers<Response>();
    const { router, feature, runtime, http } = setup("/rooms", {
      "POST /rooms/creation-operation": () => operation.promise.then((value) => value.clone()),
      "POST /rooms": () => jsonResponse({ room: waitingRoom(), invitation: INVITATION }),
    });
    await ready(router);
    const invoke = () =>
      feature.setup.action({
        request: new Request("https://arena.test/rooms", {
          method: "POST",
          body: new URLSearchParams({
            intent: "create",
            ownerColor: "white",
            expectedIdentity: roomSession.user.id,
            generation: String(runtime.account.getSnapshot().revision),
          }),
        }),
        params: {},
        context: new RouterContextProvider(),
        url: new URL("https://arena.test/rooms"),
        pattern: "/rooms",
      });
    const first = invoke();
    const second = invoke();
    await vi.waitFor(() =>
      expect(
        http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("creation-operation"))
          .length,
      ).toBeGreaterThan(0),
    );
    operation.resolve(
      jsonResponse({ operationId: GAME_ID, expiresAt: "2027-10-01T00:00:00.000Z" }),
    );
    await Promise.all([first, second]);
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("creation-operation")),
    ).toHaveLength(1);
    expect(http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/rooms")).toHaveLength(1);
  });

  it("does not display a stale resolution after the invitation input changes", async () => {
    const response = Promise.withResolvers<Response>();
    const { router, feature, http } = setup(
      `/rooms/join#invite=${INVITATION}`,
      {
        "POST /rooms/invitations/resolve": () => response.promise,
      },
      false,
    );
    await vi.waitFor(() =>
      expect(http.fetch.mock.calls.some(([url]) => requestPath(url).endsWith("/resolve"))).toBe(
        true,
      ),
    );
    feature.memory.setInput("invalid replacement");
    response.resolve(jsonResponse({ status: "joinable" }));
    await ready(router);
    expect(feature.memory.getSnapshot().resolution).toBeNull();
  });

  it.each([
    ["ROOM_UNAVAILABLE", "unavailable"],
    ["ROOM_SELF_JOIN", "self"],
    ["ROOM_ACCOUNT_UNVERIFIED", "unverified"],
    ["RATE_LIMITED", "limited"],
    ["UNAUTHORIZED", "access"],
    ["GAME_CONFLICT", "occupied"],
  ])(
    "shows bounded %s admission feedback without exposing another game's snapshot",
    async (code, issue) => {
      const { router, feature, submit } = setup(
        `/rooms/join#invite=${INVITATION}`,
        {
          "POST /guest-session": () => jsonResponse({ status: "ready" }),
          "POST /rooms/join": () =>
            jsonResponse(
              {
                code,
                message: "private-error-canary",
                requestId: "test",
                ...(code === "GAME_CONFLICT" ? { currentSnapshot: waitingRoom().snapshot } : {}),
              },
              409,
            ),
        },
        false,
      );
      await ready(router);
      await submit("join");
      expect(feature.memory.getSnapshot()).toMatchObject({ issue, room: null });
      expect(
        JSON.stringify({ state: feature.memory.getSnapshot(), loaders: router.state.loaderData }),
      ).not.toContain("private-error-canary");
      if (issue === "access") expect(feature.memory.getSnapshot().input).toBe("");
    },
  );

  it("fences a committed creation response after departure", async () => {
    const response = Promise.withResolvers<Response>();
    const { router, feature, submit, http, navigation } = setup("/rooms", {
      "POST /rooms/creation-operation": () =>
        jsonResponse({ operationId: GAME_ID, expiresAt: "2027-10-01T00:00:00.000Z" }),
      "POST /rooms": () => response.promise,
    });
    await ready(router);
    const action = submit("create", { ownerColor: "black" });
    await vi.waitFor(() =>
      expect(http.fetch.mock.calls.some(([url]) => requestPath(url) === "/rooms")).toBe(true),
    );
    navigation.departing({ pathname: "/auth/sign-in", search: "" });
    response.resolve(jsonResponse({ room: waitingRoom("black"), invitation: INVITATION }));
    await action;
    expect(feature.memory.getSnapshot()).toMatchObject({
      room: null,
      issuedInvitation: null,
      pending: null,
    });
  });
  it("resolves a fragment invitation without guest bootstrap or private reads", async () => {
    const { router, feature, http } = setup(`/rooms/join#invite=${INVITATION}`, {}, false);
    await ready(router);
    expect(feature.memory.getSnapshot().resolution).toBe("joinable");
    expect(
      JSON.stringify({ loaders: router.state.loaderData, location: router.state.location }),
    ).not.toContain(INVITATION);
    expect(http.fetch.mock.calls.map(([url]) => requestPath(url))).toEqual(
      expect.arrayContaining(["/rooms/invitations/resolve"]),
    );
    expect(http.fetch.mock.calls.some(([url]) => requestPath(url).includes("guest-session"))).toBe(
      false,
    );
  });

  it("recovers a lost creation acknowledgement with the same operation and chosen color", async () => {
    let creates = 0;
    const { router, feature, http, submit } = setup("/rooms", {
      "POST /rooms/creation-operation": () =>
        jsonResponse({ operationId: GAME_ID, expiresAt: "2027-10-01T00:00:00.000Z" }),
      "POST /rooms": () => {
        if (++creates === 1) throw new Error("lost acknowledgement");
        return jsonResponse({ room: waitingRoom("black"), invitation: null });
      },
    });
    await ready(router);
    await submit("create", { ownerColor: "black" });
    expect(feature.memory.getSnapshot()).toMatchObject({ issue: "uncertain", pending: "create" });
    await submit("create", { ownerColor: "white" });
    expect(creates).toBe(1);
    await submit("retry-create");
    expect(router.state.location.pathname).toBe(`/games/${GAME_ID}`);
    expect(feature.memory.getSnapshot()).toMatchObject({
      room: { ownerColor: "black" },
      issuedInvitation: null,
    });
    const bodies = http.fetch.mock.calls
      .filter(([url]) => requestPath(url).endsWith("/rooms"))
      .map(([, init]) => JSON.parse(requestBody(init)) as unknown);
    expect(bodies).toEqual([
      { operationId: GAME_ID, ownerColor: "black" },
      { operationId: GAME_ID, ownerColor: "black" },
    ]);
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("creation-operation")),
    ).toHaveLength(1);
  });

  it("bootstraps only the explicit guest join and retries the identical admission without another bootstrap", async () => {
    let joins = 0;
    const { router, feature, http, submit } = setup(
      `/rooms/join#invite=${INVITATION}`,
      {
        "POST /guest-session": () => jsonResponse({ status: "ready" }),
        "POST /rooms/join": () => {
          if (++joins === 1) throw new Error("lost join acknowledgement");
          return jsonResponse(joinedRoom());
        },
      },
      false,
    );
    await ready(router);
    await submit("join");
    expect(feature.memory.getSnapshot()).toMatchObject({ issue: "uncertain", pending: "join" });
    await submit("retry-join");
    expect(router.state.location.pathname).toBe(`/games/${GAME_ID}`);
    expect(feature.memory.getSnapshot().input).toBe("");
    const bodies = http.fetch.mock.calls
      .filter(([url]) => requestPath(url).endsWith("/rooms/join"))
      .map(([, init]) => requestBody(init));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("guest-session")),
    ).toHaveLength(1);
    expect(
      JSON.stringify({
        actions: router.state.actionData,
        loaders: router.state.loaderData,
        location: router.state.location,
      }),
    ).not.toContain(INVITATION);
  });

  it.each(["departure", "pagehide", "identity"])(
    "clears invitations and fences late reads on %s",
    async (reason) => {
      const pending = Promise.withResolvers<Response>();
      const { router, feature, runtime, navigation } = setup(`/rooms/join#invite=${INVITATION}`, {
        "POST /rooms/invitations/resolve": () => pending.promise,
      });
      await vi.waitFor(() => expect(runtime.account.getSnapshot().phase).toBe("account"));
      if (reason === "departure") navigation.departing({ pathname: "/auth/sign-in", search: "" });
      else if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else await runtime.account.chooseGuest();
      pending.resolve(jsonResponse({ status: "joinable" }));
      await ready(router);
      expect(feature.memory.getSnapshot()).toMatchObject({
        input: "",
        room: null,
        resolution: null,
      });
    },
  );

  it("requires a fresh confirmation after stale owner actions, without repeating closure", async () => {
    const room = waitingRoom();
    const { router, feature, http, submit } = setup(`/games/${GAME_ID}`, {
      [`GET /rooms/${GAME_ID}`]: () => jsonResponse(room),
      [`POST /games/${GAME_ID}/lifecycle`]: () =>
        jsonResponse(
          {
            code: "GAME_CONFLICT",
            message: "safe",
            requestId: "test",
            currentSnapshot: room.snapshot,
          },
          409,
        ),
    });
    await ready(router);
    await submit("close", { gameId: GAME_ID, expectedVersion: "0", confirm: "true" });
    expect(feature.memory.getSnapshot().issue).toBe("synchronize");
    await submit("refresh-room", { gameId: GAME_ID });
    expect(feature.memory.getSnapshot().pending).toBeNull();
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle")),
    ).toHaveLength(1);
  });

  it("rejects invalid game IDs before resolving identity", async () => {
    const { router, feature, http } = setup("/absent");
    await ready(router);
    await feature.waiting.loader({
      request: new Request("https://arena.test/games/bad"),
      params: { gameId: "bad" },
      context: new RouterContextProvider(),
      url: new URL("https://arena.test/games/bad"),
      pattern: "/games/:gameId",
    });
    expect(http.fetch).not.toHaveBeenCalled();
  });
});
