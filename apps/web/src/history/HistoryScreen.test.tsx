import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";
import {
  errorResponse,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
} from "../test/fixtures";
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
const completedEntry = {
  ...entry,
  gameId: OTHER_GAME_ID,
  finishedAt: "2026-09-30T12:00:00.123456Z",
  state: "completed",
  result: "1-0",
  terminationReason: "human_resignation",
};
const accountRoutes = {
  "GET /api/auth/get-session": () => jsonResponse(session),
  "GET /profile": () => jsonResponse(profile),
} as const;
function posts(http: ReturnType<typeof createHttpMock>, path: string) {
  return http.fetch.mock.calls.filter(
    ([url, init]) => requestPath(url) === path && init?.method === "POST",
  );
}
function dialogNamed(name: string) {
  return screen.getByRole("dialog", { name });
}
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
    expect(
      screen.queryByRole("button", { name: /Delete game|Clear history/ }),
    ).not.toBeInTheDocument();
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

describe("private history deletion", () => {
  it("confirms one deletion with Cancel focused, blocks duplicate submission and reloads the page", async () => {
    let games = [entry, completedEntry];
    const response = Promise.withResolvers<Response>();
    const http = createHttpMock({
      ...accountRoutes,
      "GET /games/history?limit=20": () => jsonResponse({ games, nextCursor: null }),
      "POST /games/history/delete": () => response.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    const trigger = await screen.findByRole("button", {
      name: /^Delete game · .* · Game stopped$/,
    });
    await userEvent.click(trigger);
    let dialog = dialogNamed("Delete this game?");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toHaveAccessibleDescription(/moves, result, replay and PGN, model commentary/);
    expect(dialog).toHaveAccessibleDescription(
      /unfinished game, saved provider keys and profile are kept/,
    );
    expect(within(dialog).getByText(/AI vs human · .* · Game stopped/)).toBeVisible();
    expect(within(dialog).getByText("Player", { selector: "dd" })).toBeVisible();
    expect(within(dialog).getByText(/model-a/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(posts(http, "/games/history/delete")).toHaveLength(0);

    await userEvent.click(trigger);
    dialog = dialogNamed("Delete this game?");
    const confirm = within(dialog).getByRole("button", { name: "Delete game" });
    await userEvent.click(confirm);
    await userEvent.click(confirm);
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).toHaveTextContent("Deleting game…");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.keyboard("{Escape}");
    expect(dialogNamed("Delete this game?")).toBeVisible();
    const sent = posts(http, "/games/history/delete");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(requestBody(sent[0]?.[1]))).toEqual({ gameId: GAME_ID });
    games = [completedEntry];
    await act(async () => {
      response.resolve(jsonResponse({ status: "deleted" }));
    });
    await screen.findByText("Game deleted.");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Game stopped$/ })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Finished games" })).toHaveFocus();
    expect(screen.getByRole("link", { name: /Open replay/ })).toHaveAttribute(
      "href",
      "/?game=" + OTHER_GAME_ID,
    );
    http.assertNoUnexpectedRequests();
  });

  it("keeps an unconfirmed deletion open for a safe repeat and refreshes the list when cancelled", async () => {
    let games = [entry];
    let attempts = 0;
    const http = createHttpMock({
      ...accountRoutes,
      "GET /games/history?limit=20": () => jsonResponse({ games, nextCursor: null }),
      "POST /games/history/delete": () => {
        attempts++;
        if (attempts === 1) throw new TypeError("offline");
        if (attempts === 2) return errorResponse("INVALID_GAME_STATE", 409);
        // The server committed, but its acknowledgement is lost.
        games = [];
        throw new TypeError("connection reset");
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await userEvent.click(await screen.findByRole("button", { name: /^Delete game ·/ }));
    const dialog = dialogNamed("Delete this game?");
    const confirm = within(dialog).getByRole("button", { name: "Delete game" });
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Deletion could not be confirmed. Repeating it is safe",
      ),
    );
    expect(screen.getByRole("link", { name: /Open replay/ })).toBeInTheDocument();
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "This game is not finished. Stop it in Arena before deleting it.",
      ),
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent("could not be confirmed"),
    );
    expect(screen.queryByText(/server-message-canary/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await screen.findByText(/No completed or aborted games yet/);
    expect(screen.queryByText("Game deleted.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Finished games" })).toHaveFocus();
    expect(attempts).toBe(3);
    http.assertNoUnexpectedRequests();
  });

  it("returns to the previous page when a deletion empties a later page", async () => {
    let later = [completedEntry];
    const http = createHttpMock({
      ...accountRoutes,
      "GET /games/history?limit=20": () =>
        jsonResponse({ games: [entry], nextCursor: later.length ? cursor : null }),
      [`GET ${nextPath}`]: () => jsonResponse({ games: later, nextCursor: null }),
      "POST /games/history/delete": () => {
        later = [];
        return jsonResponse({ status: "deleted" });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await screen.findByRole("link", { name: /Open replay/ });
    await userEvent.click(screen.getByRole("button", { name: "Older games" }));
    await screen.findByText("Page 2");
    await userEvent.click(screen.getByRole("button", { name: /^Delete game · .* · White wins$/ }));
    await userEvent.click(
      within(dialogNamed("Delete this game?")).getByRole("button", { name: "Delete game" }),
    );
    await screen.findByText("Page 1");
    expect(screen.getByRole("link", { name: /Open replay/ })).toHaveAttribute(
      "href",
      "/?game=" + GAME_ID,
    );
    expect(screen.getByRole("button", { name: "Older games" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Game deleted.")).toBeVisible();
    http.assertNoUnexpectedRequests();
  });

  it("clears history only after explicit confirmation and then shows the empty state", async () => {
    let games = [entry, completedEntry];
    const http = createHttpMock({
      ...accountRoutes,
      "GET /games/history?limit=20": () => jsonResponse({ games, nextCursor: null }),
      "POST /games/history/clear": (init) => {
        expect(JSON.parse(requestBody(init))).toEqual({ confirm: true });
        games = [];
        return jsonResponse({ status: "deleted" });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await screen.findAllByRole("link", { name: /Open replay/ });
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    const dialog = dialogNamed("Clear your game history?");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toHaveAccessibleDescription(/every completed and aborted game in your history/);
    expect(dialog).toHaveAccessibleDescription(/finish after your history is cleared will remain/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(posts(http, "/games/history/clear")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await userEvent.click(
      within(dialogNamed("Clear your game history?")).getByRole("button", {
        name: "Clear history",
      }),
    );
    await screen.findByText("History cleared.");
    expect(screen.getByText(/No completed or aborted games yet/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear history" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("heading", { name: "Finished games" })).toHaveFocus();
    expect(posts(http, "/games/history/clear")).toHaveLength(1);
    http.assertNoUnexpectedRequests();
  });

  it("removes confirmed deletions from view even when the refreshed list cannot load", async () => {
    let reads = 0;
    const http = createHttpMock({
      ...accountRoutes,
      "GET /games/history?limit=20": () => {
        if (++reads === 1) {
          return jsonResponse({ games: [entry, completedEntry], nextCursor: null });
        }
        throw new TypeError("offline");
      },
      "POST /games/history/delete": () => jsonResponse({ status: "deleted" }),
      "POST /games/history/clear": () => jsonResponse({ status: "deleted" }),
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Delete game · .* · Game stopped$/ }),
    );
    await userEvent.click(
      within(dialogNamed("Delete this game?")).getByRole("button", { name: "Delete game" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Game history could not be loaded."),
    );
    expect(screen.getByText("Game deleted.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Game stopped$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open replay/ })).toHaveAttribute(
      "href",
      "/?game=" + OTHER_GAME_ID,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await userEvent.click(
      within(dialogNamed("Clear your game history?")).getByRole("button", {
        name: "Clear history",
      }),
    );
    await screen.findByText("History cleared.");
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(screen.queryByRole("link", { name: /Open replay/ })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("still saved");
    expect(reads).toBe(3);
    http.assertNoUnexpectedRequests();
  });

  it("steps back to the nearest results when a later page was emptied elsewhere", async () => {
    let older = true;
    const http = createHttpMock({
      ...accountRoutes,
      "GET /games/history?limit=20": () =>
        jsonResponse({ games: [entry], nextCursor: older ? cursor : null }),
      [`GET ${nextPath}`]: () => {
        older = false;
        return jsonResponse({ games: [], nextCursor: null });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await screen.findByRole("link", { name: /Open replay/ });
    await userEvent.click(screen.getByRole("button", { name: "Older games" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Older games" })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    expect(screen.getByText("Page 1")).toBeVisible();
    expect(screen.getByRole("link", { name: /Open replay/ })).toHaveAttribute(
      "href",
      "/?game=" + GAME_ID,
    );
    expect(screen.queryByText(/No completed or aborted games yet/)).not.toBeInTheDocument();
    http.assertNoUnexpectedRequests();
  });

  it("explains that retrying an unconfirmed clear removes every game finished by then", async () => {
    const http = createHttpMock({
      ...accountRoutes,
      "GET /games/history?limit=20": () => jsonResponse({ games: [entry], nextCursor: null }),
      "POST /games/history/clear": () => {
        throw new TypeError("connection reset");
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await screen.findByRole("link", { name: /Open replay/ });
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    const dialog = dialogNamed("Clear your game history?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Clearing could not be confirmed. Cancel to refresh your history, or try again to clear every game finished by now.",
      ),
    );
    http.assertNoUnexpectedRequests();
  });

  it("abandons a pending deletion when the account changes and ignores its late result", async () => {
    let current = session;
    const response = Promise.withResolvers<Response>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(current),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/history?limit=20": () =>
        jsonResponse({ games: current === session ? [entry] : [], nextCursor: null }),
      "POST /games/history/delete": () => response.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await userEvent.click(await screen.findByRole("button", { name: /^Delete game ·/ }));
    await userEvent.click(
      within(dialogNamed("Delete this game?")).getByRole("button", { name: "Delete game" }),
    );
    current = { ...session, user: { ...session.user, id: OTHER_GAME_ID } };
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await screen.findByText(/No completed or aborted games yet/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {
      response.resolve(jsonResponse({ status: "deleted" }));
    });
    expect(screen.queryByText("Game deleted.")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    http.assertNoUnexpectedRequests();
  });
});
