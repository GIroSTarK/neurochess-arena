import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestPath, snapshot } from "../test/fixtures";
import { createHttpMock } from "../test/http";

import { useSandbox } from "./useSandbox";

function RouteWrapper({ children }: { readonly children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[window.location.pathname]}>
      <Routes>
        <Route path="/sandbox" element={children} />
        <Route path="/sandbox/games/:gameId" element={children} />
      </Routes>
    </MemoryRouter>
  );
}

describe("useSandbox", () => {
  let http: ReturnType<typeof createHttpMock>;
  afterEach(() => http.assertNoUnexpectedRequests());

  it("keeps one connected controller across renders", async () => {
    window.history.replaceState(null, "", "/sandbox");
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { result, rerender, unmount } = renderHook(() => useSandbox("http://localhost:3001"), {
      wrapper: RouteWrapper,
    });
    const { controller } = result.current;
    await waitFor(() => expect(result.current.state.readiness).toBe("ready"));
    expect(result.current.state.phase).toBe("entry");
    rerender();
    rerender();
    expect(result.current.controller).toBe(controller);
    expect(http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/ready")).toHaveLength(1);
    unmount();
  });

  it("clears an active game on pagehide and requires paused recovery on persisted pageshow", async () => {
    window.history.replaceState(null, "", "/sandbox/games/" + GAME_ID);
    let stored = snapshot([], { state: "paused", legalMoves: [], version: 1 });
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      [`GET /games/${GAME_ID}`]: () => jsonResponse(stored),
      [`POST /games/${GAME_ID}/lifecycle`]: () => {
        stored = snapshot([], { state: "paused", legalMoves: [], version: 3 });
        return jsonResponse(stored);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { result, unmount } = renderHook(() => useSandbox("http://localhost:3001"), {
      wrapper: ({ children }) => (
        <StrictMode>
          <RouteWrapper>{children}</RouteWrapper>
        </StrictMode>
      ),
    });
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    const controller = result.current.controller;
    stored = snapshot([], { version: 2 });
    await act(() => fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true })));
    expect(result.current.state.snapshot).toBeNull();
    await act(() => fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true })));
    await waitFor(() => expect(result.current.state.snapshot?.version).toBe(3));
    expect(result.current.state.snapshot?.state).toBe("paused");
    expect(result.current.controller).toBe(controller);
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle")),
    ).toHaveLength(1);
    unmount();
    expect(controller.getSnapshot().snapshot).toBeNull();
  });
});
