import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderLocalized } from "../test/render";

import { ErrorBoundary } from "./ErrorBoundary";

function Broken(): never {
  throw new Error("render-secret-canary");
}

describe("error boundary", () => {
  it("renders its children while nothing fails", () => {
    renderLocalized(
      <ErrorBoundary>
        <p>Board</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Board")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("replaces a failed tree with the localized failure screen and never shows the exception", async () => {
    const caught: unknown[] = [];
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    renderLocalized(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
      {
        onCaughtError: (error: unknown) => {
          caught.push(error);
        },
      },
    );
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByText(/Reload to continue/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("render-secret-canary");
    expect(document.title).toBe("Neurochess Arena");
    // React still receives the exception through the root handler; only the page omits it.
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(Error);
    expect(caught[0]).toHaveProperty("message", "render-secret-canary");
    await userEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
