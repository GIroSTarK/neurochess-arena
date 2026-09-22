import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestPath, snapshot } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderLocalized } from "../test/render";

import { App } from "./App";

function visit(path: string, sandboxEnabled: boolean) {
  window.history.replaceState(null, "", path);
  return renderLocalized(
    <App apiBaseUrl="http://localhost:3001" sandboxEnabled={sandboxEnabled} />,
  );
}

describe("Arena and Sandbox routes", () => {
  let http: ReturnType<typeof createHttpMock>;
  beforeEach(() => {
    http = createHttpMock({
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: snapshot(), configuration: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
  });
  afterEach(() => http.assertNoUnexpectedRequests());

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
          ([url, options]) => requestPath(url) === "/games/unfinished" && options?.method === "GET",
        ),
      ).toBe(true);
    },
  );

  it.each([
    { name: "entry path", path: "/sandbox" },
    { name: "trailing slash", path: "/sandbox/" },
    { name: "game query", path: "/sandbox?game=" + GAME_ID },
  ])("blocks disabled Sandbox route: $name", ({ path }) => {
    visit(path, false);
    expect(screen.getByRole("heading", { name: "Page unavailable" })).toBeInTheDocument();
    expect(document.title).toBe("Page unavailable · Neurochess Arena");
    expect(screen.queryByRole("link", { name: "Sandbox" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Arena" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(http.fetch).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search).toBe(path);
  });

  it("does not treat an unknown route as a sandbox game", () => {
    visit("/missing?game=" + GAME_ID, true);
    expect(screen.getByRole("heading", { name: "Page unavailable" })).toBeInTheDocument();
    expect(http.fetch).not.toHaveBeenCalled();
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
    const length = window.history.length;
    visit("/sandbox?game=" + GAME_ID, true);
    await screen.findByRole("button", { name: "Resume" });
    expect(window.location.pathname).toBe("/sandbox");
    expect(window.location.search).toBe("?game=" + GAME_ID);
    expect(window.history.length).toBe(length);
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
      visit("/?game=" + GAME_ID, enabled);
      expect(
        await screen.findByText("This game belongs to the development Sandbox."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Return to Sandbox" }) !== null).toBe(enabled);
      expect(
        http.fetch.mock.calls.every(
          ([url, options]) =>
            requestPath(url) === "/games/" + GAME_ID + "/details" && options?.method === "GET",
        ),
      ).toBe(true);
    },
  );
});
