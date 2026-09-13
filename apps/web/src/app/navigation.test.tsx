import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestPath, snapshot } from "../test/fixtures";
import { renderLocalized } from "../test/render";

import { App } from "./App";

function visit(path: string, sandboxEnabled: boolean) {
  window.history.replaceState(null, "", path);
  return renderLocalized(
    <App apiBaseUrl="http://localhost:3001" sandboxEnabled={sandboxEnabled} />,
  );
}

describe("Arena and Sandbox routes", () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  beforeEach(() => {
    fetch.mockReset();
    vi.stubGlobal("fetch", fetch);
  });

  it.each([true, false])("keeps Arena independent of the API (sandbox enabled: %s)", (enabled) => {
    visit("/?unrelated=value", enabled);
    expect(screen.getByRole("heading", { name: "Arena", level: 1 })).toBeInTheDocument();
    expect(document.title).toBe("Neurochess Arena");
    const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
    expect(navigation.getByRole("link", { name: "Arena" })).toHaveAttribute("aria-current", "page");
    expect(navigation.queryByRole("link", { name: "Sandbox" }) !== null).toBe(enabled);
    expect(screen.queryByRole("link", { name: "Open development sandbox" }) !== null).toBe(enabled);
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["/sandbox", "/sandbox/", "/sandbox?game=" + GAME_ID])(
    "blocks %s without mounting or requesting the disabled sandbox",
    (path) => {
      visit(path, false);
      expect(screen.getByRole("heading", { name: "Page unavailable" })).toBeInTheDocument();
      expect(document.title).toBe("Page unavailable · Neurochess Arena");
      expect(screen.queryByRole("link", { name: "Sandbox" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to Arena" })).toHaveAttribute("href", "/");
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled();
      expect(window.location.pathname + window.location.search).toBe(path);
    },
  );

  it("does not treat an unknown route as a sandbox game", () => {
    visit("/missing?game=" + GAME_ID, true);
    expect(screen.getByRole("heading", { name: "Page unavailable" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("recovers a private game at its Sandbox URL", async () => {
    const paused = snapshot([], { state: "paused", legalMoves: [], version: 1 });
    fetch.mockImplementation((input) =>
      Promise.resolve(jsonResponse(requestPath(input) === "/ready" ? { status: "ready" } : paused)),
    );
    const length = window.history.length;
    visit("/sandbox?game=" + GAME_ID, true);
    await screen.findByRole("button", { name: "Resume" });
    expect(window.location.pathname).toBe("/sandbox");
    expect(window.location.search).toBe("?game=" + GAME_ID);
    expect(window.history.length).toBe(length);
    expect(document.title).toBe("Development sandbox · Neurochess Arena");
    expect(screen.getByRole("link", { name: "Sandbox" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Arena" })).toHaveAttribute("href", "/");
    expect(fetch.mock.calls.map(([input]) => requestPath(input))).toContain("/games/" + GAME_ID);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it.each([true, false])("keeps game parameters scoped to Sandbox (enabled: %s)", (enabled) => {
    visit("/?game=" + GAME_ID, enabled);
    expect(screen.getByRole("heading", { name: "Arena", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(fetch).not.toHaveBeenCalled();
  });
});
