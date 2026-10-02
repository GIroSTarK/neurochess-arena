import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";
import { GAME_ID, jsonResponse, OTHER_GAME_ID } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderLocalized } from "../test/render";

const session = {
  user: { id: GAME_ID, email: "private@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
const profile = {
  username: "Player",
  completed: true,
  avatar: { source: "initials", initials: "PL" },
};
const entry = {
  gameId: GAME_ID,
  finishedAt: "2026-10-01T12:00:00.123456Z",
  configuration: {
    mode: "ai_vs_human",
    seats: {
      white: { type: "human" },
      black: { type: "ai", provider: "openai", modelId: "model-a", parameters: {} },
    },
  },
  state: "aborted",
  result: "*",
  terminationReason: "aborted",
};
const cursor = entry.finishedAt + "_" + GAME_ID;
const nextPath = "/games/history?" + new URLSearchParams({ limit: "20", cursor }).toString();
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function visit() {
  window.history.replaceState(null, "", "/history");
  return renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
}

describe("private history presentation", () => {
  it("explains guest history and returns sign-in to history without making game requests", async () => {
    const http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null) });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await screen.findByRole("heading", { name: "Private game history" });
    expect(screen.getByText(/Guest games stay separate/)).toBeVisible();
    expect(
      screen
        .getAllByRole("link", { name: "Sign in" })
        .every((link) => link.getAttribute("href") === "/auth/sign-in?returnTo=%2Fhistory"),
    ).toBe(true);
    http.assertNoUnexpectedRequests();
  });
  it("shows terminal state, players and replay links, and retries a failed next page without losing the current one", async () => {
    let failed = true;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/history?limit=20": () => jsonResponse({ games: [entry], nextCursor: cursor }),
      [`GET ${nextPath}`]: () => {
        if (failed) {
          failed = false;
          throw new TypeError("offline");
        }
        return jsonResponse({
          games: [
            {
              ...entry,
              gameId: OTHER_GAME_ID,
              state: "completed",
              result: "1-0",
              terminationReason: "human_resignation",
            },
          ],
          nextCursor: null,
        });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    const replay = await screen.findByRole("link", { name: /Open replay/ });
    expect(replay).toHaveAttribute("href", "/?game=" + GAME_ID);
    expect(screen.getByText("Aborted", { exact: true })).toBeVisible();
    expect(screen.getByText("Player", { selector: "dd" })).toBeVisible();
    expect(screen.getByText(/model-a/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Older games" }));
    await screen.findByRole("alert");
    expect(replay).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry history" }));
    await screen.findByText("Completed", { exact: true });
    expect(screen.getByRole("link", { name: /Open replay/ })).toHaveAttribute(
      "href",
      "/?game=" + OTHER_GAME_ID,
    );
    expect(screen.getByRole("button", { name: "Older games" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Newer games" }));
    await screen.findByText("Aborted", { exact: true });
    http.assertNoUnexpectedRequests();
  });
  it("shows an empty state and clears private rows across account changes, including a late old-account response", async () => {
    let current = session;
    const delayed = Promise.withResolvers<Response>();
    let reads = 0;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(current),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/history?limit=20": () =>
        ++reads === 1 ? delayed.promise : jsonResponse({ games: [], nextCursor: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await vi.waitFor(() => expect(reads).toBe(1));
    current = { ...session, user: { ...session.user, id: OTHER_GAME_ID } };
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await screen.findByText(/No completed or aborted games yet/);
    await act(async () => {
      delayed.resolve(jsonResponse({ games: [entry], nextCursor: null }));
    });
    expect(screen.queryByRole("link", { name: /Open replay/ })).not.toBeInTheDocument();
    http.assertNoUnexpectedRequests();
  });
});
