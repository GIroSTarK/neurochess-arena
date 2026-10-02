import { act, fireEvent, screen, within } from "@testing-library/react";
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
  it("confirms one game separately, initially focuses Cancel, and prevents duplicate deletion", async () => {
    let removed = false;
    const pending = Promise.withResolvers<Response>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/history?limit=20": () =>
        jsonResponse({ games: removed ? [] : [entry], nextCursor: null }),
      [`POST /games/${GAME_ID}/delete`]: () => pending.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    const trigger = await screen.findByRole("button", { name: /Delete game ·/ });
    await userEvent.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Delete this game?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(
      within(dialog).getByText(/moves, players, commentary, invocation attempts/),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(http.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      0,
    );
    await userEvent.click(trigger);
    dialog = screen.getByRole("dialog");
    await userEvent.dblClick(within(dialog).getByRole("button", { name: "Delete game" }));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    const writes = http.fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]?.body).toBe(JSON.stringify({ gameId: GAME_ID, confirm: true }));
    expect(writes[0]?.[1]?.headers).toMatchObject({ "x-neurochess-expected-account": GAME_ID });
    await act(async () => {
      removed = true;
      pending.resolve(jsonResponse({ status: "deleted" }));
    });
    await screen.findByText(/No completed or aborted games yet/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Finished games" })).toHaveFocus();
    expect(screen.getByText("Game deleted.")).toBeVisible();
    http.assertNoUnexpectedRequests();
  });

  it("keeps rows on an unconfirmed delete and permits explicit retry without claiming they were preserved", async () => {
    let tries = 0;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/history?limit=20": () =>
        jsonResponse({ games: tries < 2 ? [entry] : [], nextCursor: null }),
      [`POST /games/${GAME_ID}/delete`]: () => {
        if (++tries === 1) throw new TypeError("uncertain acknowledgement");
        return jsonResponse({ status: "deleted" });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await userEvent.click(await screen.findByRole("button", { name: /Delete game ·/ }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete game" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Deletion could not be confirmed");
    expect(screen.getByRole("link", { name: /Open replay/ })).toBeVisible();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete game" }),
    );
    await screen.findByText(/No completed or aborted games yet/);
    expect(tries).toBe(2);
    http.assertNoUnexpectedRequests();
  });

  it("clears all pages with a distinct confirmation and never restores deleted rows after a refresh failure", async () => {
    let cleared = false;
    let refreshFails = true;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/history?limit=20": () => {
        if (cleared && refreshFails) {
          refreshFails = false;
          throw new TypeError("offline");
        }
        return jsonResponse({ games: cleared ? [] : [entry], nextCursor: cleared ? null : cursor });
      },
      [`GET ${nextPath}`]: () =>
        jsonResponse({ games: [{ ...entry, gameId: OTHER_GAME_ID }], nextCursor: null }),
      "POST /games/history/clear": () => {
        cleared = true;
        return jsonResponse({ status: "deleted" });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    visit();
    await screen.findByRole("link", { name: /Open replay/ });
    await userEvent.click(screen.getByRole("button", { name: "Older games" }));
    await screen.findByText("Page 2");
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    const dialog = screen.getByRole("dialog", { name: "Clear all finished games?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(within(dialog).getByText(/every page/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Finished game history cleared.")).toBeVisible();
    expect(screen.queryByRole("link", { name: /Open replay/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your games are still saved/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry history" }));
    await screen.findByText(/No completed or aborted games yet/);
    expect(screen.getByText("Page 1")).toBeVisible();
    http.assertNoUnexpectedRequests();
  });
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
