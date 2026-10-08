import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, requestPath } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

import { useSandbox } from "./use-sandbox";

describe("useSandbox with the application data routes", () => {
  let http: ReturnType<typeof createHttpMock>;
  afterEach(() => http.assertNoUnexpectedRequests());

  it("keeps one controller across loader revalidation without repeating initial reads in effects", async () => {
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    let current: ReturnType<typeof useSandbox> | undefined;
    function Probe() {
      current = useSandbox("http://localhost:3001");
      return null;
    }
    const { router, unmount } = renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: true },
      {
        initialEntries: ["/sandbox"],
        strict: true,
        configureRoutes(routes) {
          const sandbox = routes[0]!.children!.find((route) => route.id === "sandbox")!;
          sandbox.lazy = async () => ({ Component: Probe });
        },
      },
    );
    await waitFor(() => expect(current?.state.readiness).toBe("ready"));
    const controller = current!.controller;
    expect(current!.state.phase).toBe("entry");
    expect(http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/ready")).toHaveLength(1);
    await act(() => router.revalidate());
    expect(current!.controller).toBe(controller);
    expect(http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/ready")).toHaveLength(2);
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/sandbox/games/unfinished"),
    ).toHaveLength(2);
    unmount();
    expect(controller.getSnapshot().snapshot).toBeNull();
  });
});
