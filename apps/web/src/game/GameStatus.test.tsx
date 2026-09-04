import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createSandboxApi } from "../api/client";
import { FOOLS_MATE, readyState, snapshot } from "../test/fixtures";
import { StableText } from "../ui/StableText";

import { SandboxController, type SandboxState } from "./controller";
import { GameStatus } from "./GameStatus";

function props(overrides: Partial<SandboxState> = {}) {
  // Inert until connected; only the props contract needs a controller.
  const controller = new SandboxController(createSandboxApi("http://localhost:3001"));
  return { state: readyState(overrides), controller };
}

const paused = () => snapshot([], { state: "paused", legalMoves: [], version: 1 });

describe("stable game status feedback", () => {
  it("retains the same feedback slot and controls through active, pending, and paused states", () => {
    const initial = props();
    const { container, rerender } = render(<GameStatus {...initial} />);
    const feedback = container.querySelector<HTMLElement>("[data-testid=status-feedback]")!;
    const activity = feedback.querySelector("[data-testid=activity-feedback]");
    const control = screen.getByRole("button", { name: "Pause" });
    const paragraphs = () =>
      within(feedback)
        .queryAllByRole("paragraph")
        .map((p) => p.textContent);
    expect(paragraphs()).toEqual([]);
    expect(screen.getByRole("heading", { name: "White to move" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Game paused" })).toBeNull();

    const pending = {
      action: "resume" as const,
      gameId: initial.state.snapshot!.gameId,
      expectedVersion: 1,
      commandId: crypto.randomUUID(),
    };
    rerender(<GameStatus {...initial} state={{ ...initial.state, snapshot: paused() }} />);
    expect(paragraphs()).toEqual([
      "Your full move history is preserved. Choose Resume to continue playing.",
    ]);
    expect(screen.getByRole("button", { name: "Resume" })).toBe(control);
    expect(screen.getByRole("heading", { name: "Game paused" })).toBeInTheDocument();

    rerender(
      <GameStatus
        {...initial}
        state={{
          ...initial.state,
          snapshot: paused(),
          phase: "submitting",
          pendingCommand: pending,
        }}
      />,
    );
    expect(paragraphs()).toEqual([
      "Applying your game command…",
      "You can still inspect the board while the move is confirmed.",
    ]);
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(activity).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { name: "Game paused" })).toBeInTheDocument();

    rerender(<GameStatus {...initial} />);
    expect(container.querySelector("[data-testid=status-feedback]")).toBe(feedback);
    expect(feedback.querySelector("[data-testid=activity-feedback]")).toBe(activity);
    expect(screen.getByRole("button", { name: "Pause" })).toBe(control);
    expect(paragraphs()).toEqual([]);
  });

  it.each([
    ["existing", "You already have a game in progress. Your current position is open."],
    ["recovered", "Your game has been recovered and paused. Choose Resume when you are ready."],
    ["synchronized", "The accepted position is up to date."],
  ] as const)("exposes only the %s notice in place of the paused hint", (notice, message) => {
    const initial = props({ snapshot: paused(), notice });
    const { container, rerender } = render(<GameStatus {...initial} />);
    const feedback = container.querySelector<HTMLElement>("[data-testid=status-feedback]")!;
    expect(
      within(feedback)
        .getAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual([message]);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.queryByRole("status")).toBeNull();

    rerender(<GameStatus {...initial} state={{ ...initial.state, phase: "recovering" }} />);
    expect(
      within(feedback)
        .getAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual([
      "Recovering your game…",
      "You can still inspect the board while the move is confirmed.",
    ]);
  });

  it("keeps error explanations and their synchronization feedback accessible", () => {
    const initial = props({ phase: "synchronizing", notice: "ILLEGAL_MOVE" });
    const { container, rerender } = render(<GameStatus {...initial} />);
    const feedback = container.querySelector<HTMLElement>("[data-testid=status-feedback]")!;
    expect(
      within(feedback)
        .getAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual([
      "Checking the accepted position…",
      "You can still inspect the board while the move is confirmed.",
    ]);
    expect(screen.getByText("That move is no longer legal.")).toBeInTheDocument();
    rerender(<GameStatus {...initial} state={{ ...initial.state, phase: "ready" }} />);
    expect(
      screen
        .getAllByRole("paragraph")
        .filter((p) => p.textContent === "The accepted position is up to date."),
    ).toHaveLength(1);
  });

  it("retains actionable recovery and the terminal result without hidden interactive copies", () => {
    const initial = props({ snapshot: paused(), phase: "uncertain", notice: "uncertain" });
    const { container, rerender } = render(<GameStatus {...initial} />);
    expect(screen.getByRole("button", { name: "Check game status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-disabled", "true");
    expect(container.querySelectorAll('[aria-hidden="true"] button')).toHaveLength(0);

    rerender(
      <GameStatus
        {...initial}
        state={{ ...initial.state, snapshot: snapshot(FOOLS_MATE), phase: "ready", notice: null }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Black wins" })).toBeInTheDocument();
    expect(screen.getByText("Checkmate")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New game" })).toBeEnabled();
    expect(screen.queryByRole("group", { name: "Game controls" })).toBeNull();
    expect(container.querySelector("[data-testid=status-feedback]")).toBeNull();
  });

  it("does not duplicate an accessible label when translations are identical", () => {
    render(
      <button type="button">
        <StableText value="Continue" variants={["Continue", "Continue"]} />
      </button>,
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getAllByText("Continue")).toHaveLength(1);
  });
});
