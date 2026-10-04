import { aiGameConfigurationSchema, modelDiscoveryRequestSchema } from "@neurochess/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RouteObject } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumeAuthEntry } from "../auth/navigation";
import { setupModels } from "../test/ai-setup";
import {
  FOOLS_MATE,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

const options = { apiBaseUrl: "http://localhost:3001", sandboxEnabled: true };
const gamePath = "/games/" + GAME_ID;
const configuration = {
  mode: "ai_vs_ai",
  seats: {
    white: { type: "ai", provider: "openai", modelId: "fixture/model-a", parameters: {} },
    black: { type: "ai", provider: "openai", modelId: "fixture/model-a", parameters: {} },
  },
} as const;

function routeById(routes: RouteObject[], id: string): RouteObject {
  for (const route of routes) {
    if (route.id === id) return route;
    if (route.children) {
      const child = route.children
        .flatMap(function flatten(route): RouteObject[] {
          return [route, ...(route.children?.flatMap(flatten) ?? [])];
        })
        .find((route) => route.id === id);
      if (child) return child;
    }
  }
  throw new Error("Missing test route");
}

describe("Data router integration", () => {
  let http: ReturnType<typeof createHttpMock>;
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    http.assertNoUnexpectedRequests();
  });

  it.each([gamePath, gamePath.toUpperCase().replace("/GAMES/", "/games/"), gamePath + "/"])(
    "uses a validated path UUID without normalizing the supplied URL: %s",
    async (path) => {
      http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(null),
        [`GET /games/${GAME_ID}/details`]: () =>
          jsonResponse({ snapshot: snapshot(), configuration: null }),
      });
      vi.stubGlobal("fetch", http.fetch);
      const { router } = renderApp(options, { initialEntries: [path] });
      const link = await screen.findByRole("link", { name: "Return to Sandbox" });
      expect(link).toHaveAttribute("href", "/sandbox/games/" + GAME_ID);
      expect(router.state.location.pathname).toBe(path);
      expect(screen.getByRole("link", { name: "Arena" })).toHaveAttribute("aria-current", "page");
    },
  );

  it("changes auth forms and return destinations from the current route", async () => {
    http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null) });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, {
      initialEntries: ["/auth/sign-in?returnTo=%2Fhistory"],
    });
    expect(await screen.findByRole("link", { name: "Return to Arena" })).toHaveAttribute(
      "href",
      "/history",
    );
    await userEvent.click(screen.getByRole("link", { name: "Create an account" }));
    expect(await screen.findByRole("button", { name: "Create account" })).toBeVisible();
    await act(() =>
      router.navigate("/auth/forgot-password?returnTo=" + encodeURIComponent(gamePath)),
    );
    expect(await screen.findByRole("button", { name: "Request reset link" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Return to Arena" })).toHaveAttribute("href", gamePath);
    expect(JSON.stringify(router.state.location.state)).not.toContain("returnTo");
  });

  it("keeps reset tokens across StrictMode replay but destroys them on departure and Back", async () => {
    http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null) });
    vi.stubGlobal("fetch", http.fetch);
    window.history.replaceState(null, "", "/auth/reset-password#token=reset-route-canary");
    const entry = consumeAuthEntry();
    const { router } = renderApp(
      { ...options, authEntry: entry },
      { strict: true, initialEntries: ["/auth/reset-password"] },
    );
    expect(await screen.findByLabelText("Password", { exact: true })).toBeVisible();
    expect(entry.readResetToken()).toBe("reset-route-canary");
    expect(
      JSON.stringify({
        data: router.state.loaderData,
        action: router.state.actionData,
        fetchers: [...router.state.fetchers],
        location: router.state.location,
        history: window.history.state as unknown,
      }),
    ).not.toContain("reset-route-canary");
    await act(() => router.navigate("/auth/sign-in"));
    expect(entry.readResetToken()).toBeNull();
    await act(() => router.navigate(-1));
    expect(screen.queryByLabelText("Password", { exact: true })).not.toBeInTheDocument();
  });

  it("uses the returning auth route after leaving and remounting the public branch", async () => {
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, {
      initialEntries: ["/auth/sign-in?returnTo=" + encodeURIComponent(gamePath)],
    });
    await screen.findByRole("link", { name: "Return to Arena" });
    await act(() => router.navigate("/auth/sign-in?returnTo=%2Fhistory"));
    await act(() => router.navigate("/sandbox"));
    await screen.findByRole("button", { name: "Start sandbox" });
    await act(() => router.navigate(-1));
    expect(await screen.findByRole("link", { name: "Return to Arena" })).toHaveAttribute(
      "href",
      "/history",
    );
  });

  it("does not take focus back after the user reaches a destination form", async () => {
    http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null) });
    vi.stubGlobal("fetch", http.fetch);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      frames.push(callback),
    );
    const { router } = renderApp(options, { initialEntries: ["/auth/sign-in"] });
    await screen.findByLabelText("Email");
    await act(() => router.navigate("/auth/verify"));
    const email = screen.getByLabelText("Email");
    await userEvent.click(email);
    act(() => {
      for (const frame of frames) frame(0);
    });
    expect(email).toHaveFocus();
  });

  it("does not strand a pending sign-in when the same auth URL is visited again", async () => {
    const pending = Promise.withResolvers<Response>();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "POST /api/auth/sign-in/email": () => pending.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/auth/sign-in"] });
    await userEvent.type(await screen.findByLabelText("Email"), "player@example.com");
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "test-password-canary",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(() => router.navigate("/auth/sign-in"));
    await act(async () => pending.resolve(jsonResponse({ code: "AUTH_UNAVAILABLE" }, 503)));
    await waitFor(() => expect(screen.getByLabelText("Email")).not.toHaveAttribute("readonly"));
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });

  it("preserves reset input and the bootstrap token during hash-only skip navigation", async () => {
    http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null) });
    vi.stubGlobal("fetch", http.fetch);
    window.history.replaceState(null, "", "/auth/reset-password#token=skip-token-canary");
    const entry = consumeAuthEntry();
    const { router } = renderApp(
      { ...options, authEntry: entry },
      { strict: true, initialEntries: ["/auth/reset-password"] },
    );
    await userEvent.type(
      await screen.findByLabelText("Password", { exact: true }),
      "password-skip-canary",
    );
    await act(() => router.navigate("#account-main"));
    expect(entry.readResetToken()).toBe("skip-token-canary");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("password-skip-canary");
  });

  it("does not redirect from a departed onboarding form when its write finishes later", async () => {
    const pending = Promise.withResolvers<Response>();
    let completed = false;
    http = createHttpMock({
      "GET /api/auth/get-session": () =>
        jsonResponse({
          user: { id: OTHER_GAME_ID, email: "player@example.com", emailVerified: true },
          session: { expiresAt: "2027-10-01T00:00:00.000Z" },
        }),
      "GET /profile": () =>
        jsonResponse({
          username: completed ? "Player" : null,
          completed,
          avatar: { source: "initials", initials: completed ? "PL" : "?" },
        }),
      "POST /profile/onboarding": () => pending.promise,
      "GET /credentials": () => jsonResponse({ credentials: [] }),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/account"] });
    await userEvent.type(await screen.findByLabelText("Username"), "Player");
    await userEvent.click(screen.getByRole("button", { name: "Finish profile" }));
    await waitFor(() =>
      expect(
        http.fetch.mock.calls.some(([url]) => requestPath(url) === "/profile/onboarding"),
      ).toBe(true),
    );
    await userEvent.click(screen.getByRole("link", { name: "Provider keys" }));
    await screen.findByRole("heading", { name: "Saved provider keys" });
    completed = true;
    await act(async () =>
      pending.resolve(
        jsonResponse({
          username: "Player",
          completed: true,
          avatar: { source: "initials", initials: "PL" },
        }),
      ),
    );
    expect(router.state.location.pathname).toBe("/account/credentials");
    expect(screen.getByRole("heading", { name: "Saved provider keys" })).toBeVisible();
  });

  it("does not replay a consumed callback notice after another route and Back", async () => {
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    window.history.replaceState(null, "", "/?auth=email-verified");
    const { router } = renderApp(
      { ...options, authEntry: consumeAuthEntry() },
      { initialEntries: ["/"] },
    );
    expect(await screen.findByText(/Email verified/)).toBeVisible();
    await act(() => router.navigate("/auth/forgot-password"));
    await act(() => router.navigate(-1));
    await screen.findByRole("heading", { name: "Set up a game" });
    expect(screen.queryByText(/Email verified/)).not.toBeInTheDocument();
  });

  async function startGame(configureRoutes?: (routes: RouteObject[]) => void) {
    const turn = Promise.withResolvers<Response>();
    let turnSignal: AbortSignal | null | undefined;
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      "POST /guest-session": () => jsonResponse({ status: "ready" }),
      "POST /providers/models": (init) => {
        const request = modelDiscoveryRequestSchema.parse(JSON.parse(requestBody(init)));
        return jsonResponse({ ok: true, models: setupModels(request.provider) });
      },
      "POST /games": (init) =>
        jsonResponse(
          {
            snapshot: snapshot(),
            configuration: aiGameConfigurationSchema.parse(JSON.parse(requestBody(init))),
          },
          201,
        ),
      [`POST /games/${GAME_ID}/controller`]: () => jsonResponse(snapshot()),
      [`POST /games/${GAME_ID}/ai-turn`]: (init) => {
        turnSignal = init?.signal;
        return turn.promise;
      },
      [`GET /games/${GAME_ID}/invocations`]: () =>
        jsonResponse({ gameId: GAME_ID, version: 0, turns: [] }),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: snapshot(), configuration }),
      [`POST /games/${GAME_ID}/lifecycle`]: () =>
        jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 })),
    });
    vi.stubGlobal("fetch", http.fetch);
    const view = renderApp(options, {
      initialEntries: ["/"],
      ...(configureRoutes ? { configureRoutes } : {}),
    });
    await screen.findByRole("heading", { name: "Set up a game" });
    for (const color of ["White", "Black"]) {
      const seat = within(screen.getByRole("group", { name: color }));
      await userEvent.type(
        seat.getByLabelText("API key", { exact: true }),
        `${color}-route-key-canary`,
      );
      await userEvent.click(seat.getByRole("button", { name: "Load models" }));
      const model = seat.getByRole("combobox", { name: "Model" });
      await waitFor(() => expect(model).toHaveAttribute("aria-disabled", "false"));
      await userEvent.click(model);
      await userEvent.type(model, "model-a");
      await userEvent.keyboard("{Enter}");
    }
    await userEvent.click(screen.getByRole("button", { name: "Start game" }));
    await waitFor(() => expect(turnSignal).toBeDefined());
    return { ...view, turn, signal: () => turnSignal! };
  }

  it("preserves the created match and keys across leaf routes and ordinary revalidation", async () => {
    const { router, signal, turn } = await startGame();
    expect(router.state.location.pathname).toBe(gamePath);
    expect(router.state.historyAction).toBe("REPLACE");
    expect(signal().aborted).toBe(false);
    expect(screen.getByRole("grid")).toContainElement(document.activeElement as HTMLElement);
    expect(http.fetch.mock.calls.some(([url]) => requestPath(url).endsWith("/details"))).toBe(
      false,
    );
    await act(async () => turn.resolve(jsonResponse(snapshot(["e2e4"]))));
    expect(await screen.findByRole("button", { name: /e4.*White pawn/i })).toBeVisible();
    await act(() => router.revalidate());
    expect(screen.getByRole("button", { name: /e4.*White pawn/i })).toBeVisible();
    expect(signal().aborted).toBe(false);
    const requests = http.fetch.mock.calls.map(([url]) => requestPath(url));
    expect(requests.filter((path) => path.endsWith("/ai-turn"))).toHaveLength(1);
    expect(requests.filter((path) => path.endsWith("/details"))).toHaveLength(1);
    expect(requests.filter((path) => path.endsWith("/lifecycle"))).toEqual([]);
    expect(
      JSON.stringify({
        data: router.state.loaderData,
        action: router.state.actionData,
        state: router.state.location.state as unknown,
      }),
    ).not.toContain("route-key-canary");
  });

  it("ends inference before a slow destination, and a canceled departure requires recovery", async () => {
    const slow = Promise.withResolvers<null>();
    const { router, signal, turn } = await startGame((routes) => {
      routeById(routes, "public").children!.find((route) => route.path === "history")!.loader =
        () => slow.promise;
    });
    let pending: Promise<void>;
    await act(async () => {
      pending = router.navigate("/history");
    });
    expect(router.state.navigation.state).toBe("loading");
    expect(signal().aborted).toBe(true);
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await act(() => router.navigate(gamePath));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeVisible();
    await act(async () => {
      turn.resolve(jsonResponse(snapshot(["e2e4"])));
      slow.resolve(null);
      await pending;
    });
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/ai-turn")),
    ).toHaveLength(1);
  });

  it("ends the created game if its handoff navigation is canceled back to setup", async () => {
    const slow = Promise.withResolvers<null>();
    const { router, signal, turn } = await startGame((routes) => {
      routeById(routes, "arena").children!.find((route) => route.path === "games/:gameId")!.loader =
        () => slow.promise;
    });
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.navigation.location?.pathname).toBe(gamePath);
    await act(() => router.navigate("/"));
    expect(signal().aborted).toBe(true);
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await act(async () => {
      slow.resolve(null);
      turn.resolve(jsonResponse(snapshot(["e2e4"])));
    });
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("never adopts a late game A result after switching to game B within the same route pattern", async () => {
    const first = Promise.withResolvers<Response>();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      [`GET /games/${GAME_ID}/details`]: () => first.promise,
      [`GET /games/${OTHER_GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: snapshot([], { gameId: OTHER_GAME_ID }), configuration: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: [gamePath] });
    await waitFor(() =>
      expect(http.fetch.mock.calls.some(([url]) => requestPath(url).endsWith("/details"))).toBe(
        true,
      ),
    );
    await act(() => router.navigate("/games/" + OTHER_GAME_ID));
    expect(await screen.findByRole("link", { name: "Return to Sandbox" })).toHaveAttribute(
      "href",
      "/sandbox/games/" + OTHER_GAME_ID,
    );
    await act(async () =>
      first.resolve(jsonResponse({ snapshot: snapshot(), configuration: null })),
    );
    expect(screen.getByRole("link", { name: "Return to Sandbox" })).toHaveAttribute(
      "href",
      "/sandbox/games/" + OTHER_GAME_ID,
    );
  });

  it("adopts a created Sandbox route before an immediate Back can reopen the previous game", async () => {
    const terminal = snapshot(FOOLS_MATE);
    let reads = 0;
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      [`GET /games/${GAME_ID}`]: () => {
        reads++;
        return jsonResponse(terminal);
      },
      [`GET /games/${GAME_ID}/replay`]: () =>
        jsonResponse({ snapshot: terminal, initialFen: snapshot().fen }),
      "POST /guest-session": () => jsonResponse({ status: "ready" }),
      "POST /sandbox/games": () => jsonResponse(snapshot([], { gameId: OTHER_GAME_ID }), 201),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/sandbox/games/" + GAME_ID] });
    await screen.findByRole("heading", { name: "Black wins by checkmate" });
    let popped = false;
    const unsubscribe = router.subscribe((state) => {
      if (
        !popped &&
        state.location.pathname === "/sandbox/games/" + OTHER_GAME_ID &&
        state.navigation.state === "idle"
      ) {
        popped = true;
        void router.navigate(-1);
      }
    });
    try {
      await userEvent.click(screen.getByRole("button", { name: "New game" }));
      await waitFor(() => expect(popped).toBe(true));
      expect(router.state.location.pathname).toBe("/sandbox/games/" + GAME_ID);
      await waitFor(() => expect(reads).toBe(2));
      expect(await screen.findByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
    } finally {
      unsubscribe();
    }
  });

  it("keeps navigation usable through a lazy failure and offers a fatal reload without exposing errors", async () => {
    const chunk = Promise.withResolvers<never>();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    let attempts = 0;
    const { router } = renderApp(options, {
      initialEntries: ["/history"],
      configureRoutes(routes) {
        const route = routeById(routes, "sandbox");
        const lazy = route.lazy;
        if (typeof lazy !== "function") throw new Error("Expected lazy Sandbox route");
        route.lazy = async () => {
          if (++attempts === 1) return chunk.promise;
          return await lazy();
        };
      },
    });
    await screen.findByRole("heading", { name: "Private game history" });
    let pending: Promise<void>;
    await act(async () => {
      pending = router.navigate("/sandbox");
    });
    expect(screen.getByRole("link", { name: "Arena" })).toBeVisible();
    expect(screen.getByText("Opening page…")).toBeVisible();
    await act(async () => {
      chunk.reject(new Error("secret-route-error-canary"));
      await pending;
    });
    expect(
      await screen.findByRole("heading", { name: "This page could not be loaded." }),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain("secret-route-error-canary");
    expect(screen.getByRole("button", { name: "Reload page" })).toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: "History" }));
    expect(await screen.findByRole("heading", { name: "Private game history" })).toBeVisible();
  });
});
