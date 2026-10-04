import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestPath, snapshot } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderLocalized } from "../test/render";

import { MatchScreen } from "./MatchScreen";

describe("native Arena navigation adapter", () => {
  let http: ReturnType<typeof createHttpMock>;
  afterEach(() => http.assertNoUnexpectedRequests());

  it("reconnects setup to the new credential owner on same-document history entry", async () => {
    window.history.replaceState(null, "", "/");
    http = createHttpMock({ "GET /games/unfinished": () => jsonResponse({ game: null }) });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<MatchScreen apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    const key = () =>
      within(screen.getByRole("group", { name: "White" })).getByLabelText("API key", {
        exact: true,
      });
    await waitFor(() => expect(key()).not.toHaveAttribute("readonly"));
    await act(() => fireEvent(window, new PopStateEvent("popstate")));
    await waitFor(() => expect(http.fetch).toHaveBeenCalledTimes(2));
    expect(key()).not.toHaveAttribute("readonly");
  });

  it("recovers once under StrictMode and recovers again without keys after bfcache restoration", async () => {
    window.history.replaceState(null, "", "/?game=" + GAME_ID);
    let stored = snapshot();
    http = createHttpMock({
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({
          snapshot: stored,
          configuration: {
            mode: "ai_vs_human",
            seats: {
              white: { type: "human" },
              black: { type: "ai", provider: "openai", modelId: "fixture", parameters: {} },
            },
          },
        }),
      [`GET /games/${GAME_ID}/invocations`]: () =>
        jsonResponse({ gameId: GAME_ID, version: stored.version, turns: [] }),
      [`POST /games/${GAME_ID}/lifecycle`]: () => {
        stored = snapshot([], { state: "paused", legalMoves: [], version: stored.version + 1 });
        return jsonResponse(stored);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { unmount } = renderLocalized(
      <StrictMode>
        <MatchScreen apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />
      </StrictMode>,
    );
    await screen.findByRole("button", { name: "Resume" });
    const pauses = () =>
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle"));
    expect(pauses()).toHaveLength(1);
    await act(() => fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true })));
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await act(() => fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true })));
    await waitFor(() => expect(pauses()).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "Resume" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    unmount();
    const requests = http.fetch.mock.calls.length;
    await act(() => fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true })));
    expect(http.fetch).toHaveBeenCalledTimes(requests);
  });
});
