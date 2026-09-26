import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";
import { jsonResponse } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderLocalized } from "../test/render";

const id = "e13d2b75-702c-45cd-ac8b-333333333333";
const date = "2026-09-26T12:00:00.123456Z";
const cursor = `${date}/${id}`;
const item = {
  gameId: id,
  finishedAt: date,
  mode: "ai_vs_human",
  state: "completed",
  result: "1-0",
  terminationReason: "human_resignation",
  players: {
    white: { type: "human", username: "Alice" },
    black: { type: "ai", provider: "openai", modelId: "untrusted-model" },
  },
};
const session = (name: string) => ({
  user: { id: name, email: name + "@example.test", emailVerified: true },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
const profile = (name: string) => ({
  username: name,
  onboardingRequired: false,
  avatar: { source: "initials", initials: name.slice(0, 2).toUpperCase() },
  providerAvatar: null,
});
let http: ReturnType<typeof createHttpMock>;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/history");
});
afterEach(() => {
  http.assertNoUnexpectedRequests();
  localStorage.clear();
});
function renderApp() {
  vi.stubGlobal("fetch", http.fetch);
  return renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
}

describe("private history navigation", () => {
  it("confirms one game with Cancel focused, prevents duplicate submissions and refreshes the list", async () => {
    let deleted = false;
    let submissions = 0;
    const response = Promise.withResolvers<Response>();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: session("Alice") }),
      "GET /api/profile": () => jsonResponse(profile("Alice")),
      "GET /games/history": () => jsonResponse({ games: deleted ? [] : [item], nextCursor: null }),
      [`POST /games/${id}/delete`]: (options) => {
        expect(options?.body).toBe(JSON.stringify({ confirm: true }));
        expect(new Headers(options?.headers).get("X-Neurochess-Identity")).toBe("account");
        submissions++;
        return response.promise;
      },
    });
    renderApp();
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "Delete game" });
    await user.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Delete this game?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toHaveTextContent("untrusted-model");
    expect(dialog).toHaveTextContent(/moves.*commentary.*invocation/i);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(submissions).toBe(0);
    await user.click(trigger);
    dialog = screen.getByRole("dialog");
    await user.dblClick(within(dialog).getByRole("button", { name: "Delete game" }));
    expect(submissions).toBe(1);
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    deleted = true;
    await act(async () => response.resolve(jsonResponse({ success: true })));
    expect(await screen.findByText("You have no completed or aborted games yet.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Game deleted.")).toHaveAttribute("role", "status");
    expect(screen.getByText("Game deleted.")).toHaveFocus();
  });

  it("keeps history on a failed clear, explains uncertain outcomes and requires an explicit retry", async () => {
    let cleared = false;
    let attempts = 0;
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: session("Alice") }),
      "GET /api/profile": () => jsonResponse(profile("Alice")),
      "GET /games/history": () => jsonResponse({ games: cleared ? [] : [item], nextCursor: null }),
      "POST /games/history/clear": () => {
        if (++attempts === 1) throw new Error("private-database-error");
        cleared = true;
        return jsonResponse({ success: true });
      },
    });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Clear history" }));
    let dialog = screen.getByRole("dialog", { name: "Clear all game history?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toHaveTextContent(/active.*paused/i);
    expect(dialog).toHaveTextContent(/saved.*credentials/i);
    expect(dialog).toHaveTextContent(/completed.*after/i);
    await user.click(within(dialog).getByRole("button", { name: "Clear history" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/could not confirm/i);
    expect(document.body).not.toHaveTextContent("private-database-error");
    expect(screen.getByRole("link", { name: "Replay game" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Clear history" }));
    dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Clear history" }));
    expect(await screen.findByText("You have no completed or aborted games yet.")).toBeVisible();
    expect(attempts).toBe(2);
  });

  it("refreshes unavailable games without offering an automatic destructive retry", async () => {
    let missing = false;
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: session("Alice") }),
      "GET /api/profile": () => jsonResponse(profile("Alice")),
      "GET /games/history": () => jsonResponse({ games: missing ? [] : [item], nextCursor: null }),
      [`POST /games/${id}/delete`]: () => {
        missing = true;
        return jsonResponse({ code: "NOT_FOUND", message: "private", requestId: "test" }, 404);
      },
    });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete game" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete game" }),
    );
    expect(await screen.findByText("You have no completed or aborted games yet.")).toBeVisible();
    expect(screen.getByText(/This game is already unavailable/)).toHaveAttribute("role", "status");
  });

  it("cancels a pending deletion and discards its result after switching accounts", async () => {
    let name = "Alice";
    let signal: AbortSignal | null | undefined;
    const response = Promise.withResolvers<Response>();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: session(name) }),
      "GET /api/profile": () => jsonResponse(profile(name)),
      "GET /games/history": () =>
        jsonResponse({ games: name === "Alice" ? [item] : [], nextCursor: null }),
      [`POST /games/${id}/delete`]: (options) => {
        signal = options?.signal;
        return response.promise;
      },
    });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete game" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete game" }),
    );
    await waitFor(() => expect(signal).toBeDefined());
    name = "Bobby";
    await act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: "neurochess.identity-change", newValue: "changed" }),
      ),
    );
    expect(await screen.findByText("You have no completed or aborted games yet.")).toBeVisible();
    expect(signal?.aborted).toBe(true);
    await act(async () => response.resolve(jsonResponse({ success: true })));
    expect(screen.queryByText("Game deleted.")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("labels a legacy unnamed human seat without requiring onboarding for read-only history", async () => {
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: session("Alice") }),
      "GET /api/profile": () =>
        jsonResponse({
          ...profile("Alice"),
          username: null,
          onboardingRequired: true,
          avatar: { source: "initials", initials: null },
        }),
      "GET /games/history": () =>
        jsonResponse({
          games: [
            { ...item, players: { ...item.players, white: { type: "human", username: null } } },
          ],
          nextCursor: null,
        }),
    });
    renderApp();
    expect(await screen.findByText("You · Human player")).toBeVisible();
  });

  it("shows guest guidance without history, controller, discovery or bootstrap requests", async () => {
    http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse({ session: null }) });
    renderApp();
    expect(await screen.findByRole("heading", { name: "Game history" })).toBeVisible();
    expect(screen.getByText(/Guests have no durable game history/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in to view history" })).toHaveAttribute(
      "href",
      "/auth/sign-in?returnTo=%2Fhistory",
    );
  });

  it("paginates bounded pages, labels terminal states, reuses private replay links and retries a failed page", async () => {
    let fail = true;
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: session("Alice") }),
      "GET /api/profile": () => jsonResponse(profile("Alice")),
      "GET /games/history": () => jsonResponse({ games: [item], nextCursor: cursor }),
      [`GET /games/history?cursor=${encodeURIComponent(cursor)}`]: () => {
        if (fail) {
          fail = false;
          throw new Error("private-server-detail");
        }
        return jsonResponse({
          games: [
            {
              ...item,
              gameId: "e13d2b75-702c-45cd-ac8b-444444444444",
              state: "aborted",
              result: "*",
              terminationReason: "aborted",
            },
          ],
          nextCursor: null,
        });
      },
    });
    renderApp();
    const user = userEvent.setup();
    expect(await screen.findByText("Completed", { exact: true })).toBeVisible();
    expect(screen.getByText("untrusted-model")).toBeVisible();
    expect(screen.getByRole("link", { name: "Replay game" })).toHaveAttribute(
      "href",
      `/?game=${id}`,
    );
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "Older games" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History could not be loaded");
    expect(document.body).not.toHaveTextContent("private-server-detail");
    await user.click(screen.getByRole("button", { name: "Retry history" }));
    expect(await screen.findByText("Aborted", { exact: true })).toBeVisible();
    expect(screen.getByText("Game stopped", { exact: true })).toBeVisible();
    expect(screen.queryByText("Completed", { exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Newer games" }));
    expect(await screen.findByText("Completed", { exact: true })).toBeVisible();
  });

  it("discards a delayed old-account page and clears private rows on session loss", async () => {
    let name = "Alice";
    const delayed = Promise.withResolvers<Response>();
    let signal: AbortSignal | null | undefined;
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: name ? session(name) : null }),
      "GET /api/profile": () => jsonResponse(profile(name)),
      "GET /games/history": (options) => {
        if (name === "Alice") {
          signal = options?.signal;
          return delayed.promise;
        }
        return jsonResponse({ games: [], nextCursor: null });
      },
    });
    renderApp();
    await waitFor(() => expect(signal).toBeDefined());
    name = "Bobby";
    await act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: "neurochess.identity-change", newValue: "changed" }),
      ),
    );
    expect(await screen.findByText("You have no completed or aborted games yet.")).toBeVisible();
    expect(signal?.aborted).toBe(true);
    await act(async () => delayed.resolve(jsonResponse({ games: [item], nextCursor: null })));
    expect(screen.queryByText("untrusted-model")).not.toBeInTheDocument();
    name = "";
    await act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText(/You are signed out or your session has ended/)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Game history" })).not.toBeInTheDocument();
  });
});
