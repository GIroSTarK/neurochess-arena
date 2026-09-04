import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { jsonResponse, requestPath } from "../test/fixtures";

import { useSandbox } from "./use-sandbox";

describe("useSandbox", () => {
  it("keeps one connected controller across renders", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((input) =>
      Promise.resolve(
        requestPath(input) === "/ready"
          ? jsonResponse({ status: "ready" })
          : jsonResponse({ snapshot: null }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const { result, rerender, unmount } = renderHook(() => useSandbox("http://localhost:3001"));
    const { controller } = result.current;
    await waitFor(() => expect(result.current.state.readiness).toBe("ready"));
    expect(result.current.state.phase).toBe("entry");
    rerender();
    rerender();
    expect(result.current.controller).toBe(controller);
    expect(fetch.mock.calls.filter(([url]) => requestPath(url) === "/ready")).toHaveLength(1);
    unmount();
  });
});
