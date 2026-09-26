import { act, screen, waitFor } from "@testing-library/react";
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
