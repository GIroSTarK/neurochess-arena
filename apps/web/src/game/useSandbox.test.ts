import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, requestPath } from "../test/fixtures";
import { createHttpMock } from "../test/http";

import { useSandbox } from "./useSandbox";

describe("useSandbox", () => {
  let http: ReturnType<typeof createHttpMock>;
  afterEach(() => http.assertNoUnexpectedRequests());

  it("keeps one connected controller across renders", async () => {
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { result, rerender, unmount } = renderHook(() => useSandbox("http://localhost:3001"));
    const { controller } = result.current;
    await waitFor(() => expect(result.current.state.readiness).toBe("ready"));
    expect(result.current.state.phase).toBe("entry");
    rerender();
    rerender();
    expect(result.current.controller).toBe(controller);
    expect(http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/ready")).toHaveLength(1);
    unmount();
  });
});
