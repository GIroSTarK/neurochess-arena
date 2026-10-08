import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestPath, snapshot } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

import { AppNavigation } from "./AppNavigation";

function visit(path: string, sandboxEnabled: boolean) {
  return renderApp(
    { apiBaseUrl: "http://localhost:3001", sandboxEnabled },
    { initialEntries: [path] },
  );
}

describe("Arena and Sandbox routes", () => {
  let http: ReturnType<typeof createHttpMock>;
  beforeEach(() => {
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: snapshot(), configuration: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
  });
  afterEach(() => http.assertNoUnexpectedRequests());

  it.each([true, false])("reads navigation availability from route context (%s)", (enabled) => {
    renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: enabled },
      {
        initialEntries: ["/history"],
        configureRoutes(routes) {
          routes[0]!.children = [
            {
              path: "history",
              handle: { page: "history" },
              element: <AppNavigation page="arena" />,
            },
          ];
        },
      },
    );
    expect(screen.queryByRole("link", { name: "Sandbox" }) !== null).toBe(enabled);
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("aria-current", "page");
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "opens Arena setup without creating a guest (sandbox enabled: %s)",
    async (enabled) => {
      visit("/?unrelated=value", enabled);
      expect(
        await screen.findByRole("heading", { name: "Set up a game", level: 1 }),
      ).toBeInTheDocument();
      expect(document.title).toBe("Neurochess Arena");
      const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
      expect(navigation.getByRole("link", { name: "Arena" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(navigation.queryByRole("link", { name: "Sandbox" }) !== null).toBe(enabled);
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      expect(
        http.fetch.mock.calls.every(
          ([url, options]) =>
            ["/games/unfinished", "/api/auth/get-session"].includes(requestPath(url)) &&
            options?.method === "GET",
        ),
      ).toBe(true);
    },
  );

  it.each([
    { name: "entry path", path: "/sandbox" },
    { name: "trailing slash", path: "/sandbox/" },
    { name: "game query", path: "/sandbox?game=" + GAME_ID },
    { name: "game path", path: "/sandbox/games/" + GAME_ID },
  ])("blocks disabled Sandbox route: $name", ({ path }) => {
    const { router } = visit(path, false);
    expect(screen.getByRole("heading", { name: "Page unavailable" })).toBeInTheDocument();
    expect(document.title).toBe("Page unavailable · Neurochess Arena");
    expect(screen.queryByRole("link", { name: "Sandbox" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Arena" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(http.fetch).not.toHaveBeenCalled();
    expect(router.state.location.pathname + router.state.location.search).toBe(path);
  });

  it("does not treat an unknown route as a sandbox game", () => {
    visit("/missing?game=" + GAME_ID, true);
    expect(screen.getByRole("heading", { name: "Page unavailable" })).toBeInTheDocument();
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "/?game=" + GAME_ID,
    "/?game=",
    "/?game=" + GAME_ID + "&game=" + GAME_ID,
    "/sandbox?game=" + GAME_ID,
    "/sandbox?game=",
    "/sandbox?game=" + GAME_ID + "&game=",
    "/games/" + GAME_ID + "?game=" + GAME_ID,
    "/sandbox/games/" + GAME_ID + "?game=",
    "/games/invalid",
    "/games/",
    "/games/" + GAME_ID + "/extra",
    "/games/" + GAME_ID + "%2fextra",
    "/GAMES/" + GAME_ID,
    "/sandbox/games/invalid",
  ])("rejects unsupported game target %s before any API call", async (path) => {
    const { router } = visit(path, true);
    expect(await screen.findByRole("heading", { name: "Page unavailable" })).toBeVisible();
    expect(http.fetch).not.toHaveBeenCalled();
    expect(router.state.location.pathname + router.state.location.search).toBe(path);
  });

  it.each(["/dev/arena", "/dev/arena/"])(
    "keeps the disabled reference route %s independent of the API",
    (path) => {
      visit(path, false);
      expect(screen.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
      expect(http.fetch).not.toHaveBeenCalled();
    },
  );

  it("does not expose test scenarios in production even when Sandbox is enabled", () => {
    vi.stubEnv("DEV", false);
    visit("/dev/arena", true);
    expect(screen.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it("loads the development reference screen without guest or game requests", async () => {
    vi.stubEnv("DEV", true);
    visit("/dev/arena?game=" + GAME_ID, true);
    expect(await screen.findByRole("region", { name: "Test data" })).toBeVisible();
    expect(document.title).toBe("Arena test scenarios · Neurochess Arena");
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it("recovers a private game at its Sandbox URL", async () => {
    const paused = snapshot([], { state: "paused", legalMoves: [], version: 1 });
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      [`GET /games/${GAME_ID}`]: () => jsonResponse(paused),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = visit("/sandbox/games/" + GAME_ID, true);
    await screen.findByRole("button", { name: "Resume" });
    expect(router.state.location.pathname).toBe("/sandbox/games/" + GAME_ID);
    expect(router.state.location.search).toBe("");
    expect(router.state.historyAction).toBe("POP");
    expect(document.title).toBe("Development sandbox · Neurochess Arena");
    expect(screen.getByRole("link", { name: "Sandbox" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Arena" })).toHaveAttribute("href", "/");
    expect(http.fetch.mock.calls.map(([input]) => requestPath(input))).toContain(
      "/games/" + GAME_ID,
    );
    expect(http.fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it.each([true, false])(
    "resolves Arena game URLs through authorized details (enabled: %s)",
    async (enabled) => {
      visit("/games/" + GAME_ID, enabled);
      expect(
        await screen.findByText("This game belongs to the development Sandbox."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Return to Sandbox" }) !== null).toBe(enabled);
      expect(
        http.fetch.mock.calls.every(
          ([url, options]) =>
            ["/games/" + GAME_ID + "/details", "/api/auth/get-session"].includes(
              requestPath(url),
            ) && options?.method === "GET",
        ),
      ).toBe(true);
    },
  );
});
