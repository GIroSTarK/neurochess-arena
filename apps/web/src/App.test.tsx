// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders the foundation shell and consumes the shared health contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByRole("heading", { name: "Neurochess Arena" })).toBeInTheDocument();
    expect(screen.getByText("Foundation ready")).toBeInTheDocument();
    expect(screen.getByText("Web workspace")).toBeInTheDocument();

    await waitFor(() => expect(screen.getAllByText("Connected")).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://localhost:3001/health"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("shows unavailable when the API response violates its contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "unexpected" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );

    render(<App apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
  });
});
