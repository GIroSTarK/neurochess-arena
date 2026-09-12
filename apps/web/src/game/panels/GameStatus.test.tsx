import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  FOOLS_MATE,
  GAME_ID,
  mockController,
  readyState,
  sandboxState,
  snapshot,
} from "../../test/fixtures";
import { renderLocalized } from "../../test/render";
import { StableText } from "../../ui/StableText";
import type { SandboxState } from "../state";

import { GameStatus } from "./GameStatus";

function props(state: SandboxState = readyState()) {
  return { state, controller: mockController() };
}

const paused = () => snapshot([], { state: "paused", legalMoves: [], version: 1 });

describe("stable game status feedback", () => {
  it("retains the same feedback slot and controls through active, pending, and paused states", () => {
    const initial = props();
    const { container, rerender } = renderLocalized(<GameStatus {...initial} />);
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
      gameId: GAME_ID,
      expectedVersion: 1,
      commandId: crypto.randomUUID(),
    };
    rerender(<GameStatus {...initial} state={readyState({ snapshot: paused() })} />);
    expect(paragraphs()).toEqual([
      "Your full move history is preserved. Choose Resume to continue playing.",
    ]);
    expect(screen.getByRole("button", { name: "Resume" })).toBe(control);
    expect(screen.getByRole("heading", { name: "Game paused" })).toBeInTheDocument();

    rerender(
      <GameStatus
        {...initial}
        state={sandboxState({
          snapshot: paused(),
          phase: "submitting",
          pendingCommand: pending,
        })}
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
    const initial = props(readyState({ snapshot: paused(), notice }));
    const { container, rerender } = renderLocalized(<GameStatus {...initial} />);
    const feedback = container.querySelector<HTMLElement>("[data-testid=status-feedback]")!;
    expect(
      within(feedback)
        .getAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual([message]);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.queryByRole("status")).toBeNull();

    rerender(
      <GameStatus
        {...initial}
        state={sandboxState(
          { phase: "recovering", snapshot: paused(), pendingCommand: null },
          { notice },
        )}
      />,
    );
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
    const initial = props(
      sandboxState(
        { phase: "synchronizing", snapshot: snapshot(), pendingCommand: null },
        { notice: "ILLEGAL_MOVE" },
      ),
    );
    const { container, rerender } = renderLocalized(<GameStatus {...initial} />);
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
    rerender(<GameStatus {...initial} state={readyState({ notice: "ILLEGAL_MOVE" })} />);
    expect(
      screen
        .getAllByRole("paragraph")
        .filter((p) => p.textContent === "The accepted position is up to date."),
    ).toHaveLength(1);
  });

  it("retains actionable recovery and the terminal result without hidden interactive copies", () => {
    const initial = props(
      sandboxState(
        {
          snapshot: paused(),
          phase: "uncertain",
          pendingCommand: {
            gameId: GAME_ID,
            expectedVersion: 1,
            commandId: crypto.randomUUID(),
            action: "resume",
          },
        },
        { notice: "uncertain" },
      ),
    );
    const { container, rerender } = renderLocalized(<GameStatus {...initial} />);
    expect(screen.getByRole("button", { name: "Check game status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-disabled", "true");
    expect(container.querySelectorAll('[aria-hidden="true"] button')).toHaveLength(0);

    rerender(<GameStatus {...initial} state={readyState({ snapshot: snapshot(FOOLS_MATE) })} />);
    expect(screen.getByRole("heading", { name: "Black wins" })).toBeInTheDocument();
    expect(screen.getByText("Checkmate")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New game" })).toBeEnabled();
    expect(screen.queryByRole("group", { name: "Game controls" })).toBeNull();
    expect(container.querySelector("[data-testid=status-feedback]")).toBeNull();
  });

  it("does not duplicate an accessible label when translations are identical", () => {
    renderLocalized(
      <button type="button">
        <StableText value="Continue" variants={["Continue", "Continue"]} />
      </button>,
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getAllByText("Continue")).toHaveLength(1);
  });

  it.each(["checking", "unavailable"] as const)(
    "keeps New game focusable but inactive while readiness is %s",
    async (readiness) => {
      const terminal = snapshot(FOOLS_MATE);
      const initial = props(readyState({ snapshot: terminal, readiness }));
      const { rerender } = renderLocalized(<GameStatus {...initial} />);
      const control = screen.getByRole("button", { name: "New game" });
      expect(control).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(control);
      expect(control).toHaveFocus();
      await userEvent.keyboard("{Enter} ");
      expect(initial.controller.start).not.toHaveBeenCalled();
      if (readiness === "unavailable") {
        await userEvent.click(screen.getByRole("button", { name: "Retry connection" }));
        expect(initial.controller.checkReadiness).toHaveBeenCalledTimes(1);
      }
      rerender(<GameStatus {...initial} state={readyState({ snapshot: terminal })} />);
      expect(control).toHaveAttribute("aria-disabled", "false");
      await userEvent.click(control);
      expect(initial.controller.start).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "Retry same move",
      method: "retryCommand",
      state: sandboxState(
        {
          phase: "uncertain",
          snapshot: snapshot(),
          pendingCommand: {
            gameId: GAME_ID,
            expectedVersion: 0,
            commandId: "5b6a4d1c-2f6e-4c1a-9d3b-8e7f6a5b4c3d",
            move: "e2e4",
          },
        },
        { notice: "uncertain" },
      ),
    },
    {
      name: "Check game status",
      method: "synchronize",
      state: sandboxState(
        { phase: "sync-required", snapshot: snapshot(), pendingCommand: null },
        { notice: "sync-required" },
      ),
    },
    {
      name: "Retry recovery",
      method: "recover",
      state: sandboxState(
        { phase: "recovery-required", snapshot: paused(), pendingCommand: null },
        { notice: "recovery-required" },
      ),
    },
    { name: "New game", method: "start", state: readyState({ snapshot: snapshot(FOOLS_MATE) }) },
    {
      name: "Retry connection",
      method: "checkReadiness",
      state: readyState({ readiness: "unavailable" }),
    },
  ] as const)("routes $name to the controller", async ({ name, method, state }) => {
    const initial = props(state);
    renderLocalized(<GameStatus {...initial} />);
    await userEvent.click(screen.getByRole("button", { name }));
    expect(initial.controller[method]).toHaveBeenCalledTimes(1);
  });
});
