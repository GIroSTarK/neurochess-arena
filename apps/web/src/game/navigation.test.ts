import { describe, expect, it, vi } from "vitest";

import { GAME_ID, OTHER_GAME_ID } from "../test/fixtures";

import { browserNavigation } from "./navigation";

function visit(search: string) {
  window.history.replaceState(null, "", "/sandbox" + search);
}

describe("browser navigation", () => {
  it("reads one valid game id from the URL and normalizes its case", () => {
    visit("?game=" + GAME_ID.toUpperCase());
    expect(browserNavigation().read()).toEqual({ kind: "game", gameId: GAME_ID });
  });

  it("finds no game on the sandbox entry page or among unrelated parameters", () => {
    visit("");
    expect(browserNavigation().read()).toEqual({ kind: "none" });
    visit("?other=" + GAME_ID);
    expect(browserNavigation().read()).toEqual({ kind: "none" });
  });

  it.each([
    "?game=",
    "?game=not-a-game",
    "?game=" + encodeURIComponent("../../secret"),
    "?game=" + GAME_ID + "&game=" + OTHER_GAME_ID,
    "?game=" + GAME_ID + "&game=" + GAME_ID,
  ])("treats %s as an invalid link that names no game", (search) => {
    visit(search);
    expect(browserNavigation().read()).toEqual({ kind: "invalid" });
  });

  it("opens a game by pushing its private URL, or replacing it when asked", () => {
    visit("");
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const navigation = browserNavigation();
    navigation.open(GAME_ID);
    expect(window.location.pathname + window.location.search).toBe("/sandbox?game=" + GAME_ID);
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    navigation.open(OTHER_GAME_ID, true);
    expect(window.location.search).toBe("?game=" + OTHER_GAME_ID);
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("adds no history entry for the URL that is already open", () => {
    visit("?game=" + GAME_ID);
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const length = window.history.length;
    browserNavigation().open(GAME_ID);
    browserNavigation().open(GAME_ID, true);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
  });

  it("reports history navigation until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = browserNavigation().subscribe(listener);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
