import type { CreateAiGameRequest, GameSnapshot } from "@neurochess/contracts";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiTurnApi } from "../api/ai";
import { ApiFailure, type SandboxApi } from "../api/client";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";
import { renderLocalized } from "../test/render";

import { GamePreview } from "./GamePreview";

const match = {
  mode: "ai_vs_ai",
  white: { provider: "openai", modelId: "fixture", parameters: {} },
  black: { provider: "anthropic", modelId: "fixture", parameters: {} },
} satisfies CreateAiGameRequest;

function mount(initial = snapshot()) {
  const api = {
    ready: vi.fn<SandboxApi["ready"]>().mockResolvedValue(true),
    bootstrap: vi.fn<SandboxApi["bootstrap"]>().mockResolvedValue(),
    create: vi.fn<SandboxApi["create"]>(),
    snapshot: vi.fn<SandboxApi["snapshot"]>().mockResolvedValue(initial),
    move: vi.fn<SandboxApi["move"]>(),
    lifecycle: vi.fn<SandboxApi["lifecycle"]>(),
    unfinished: vi.fn<SandboxApi["unfinished"]>().mockResolvedValue(null),
    replay: vi.fn<SandboxApi["replay"]>(),
    pgn: vi.fn<SandboxApi["pgn"]>(),
  };
  const pending = Promise.withResolvers<GameSnapshot>();
  const turnApi = { turn: vi.fn<AiTurnApi["turn"]>().mockReturnValue(pending.promise) };
  const props = {
    api,
    turnApi,
    initial,
    match,
    recovered: false,
    orientation: "white" as const,
    credential: () => ({ provider: "openai" as const, apiKey: "fixture-only" }),
    onSetup: vi.fn(),
  };
  const rendered = renderLocalized(<GamePreview key={initial.gameId} {...props} />);
  return { ...rendered, props, api, turnApi, pending };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("AI arena lifecycle feedback", () => {
  it.each(["pause", "resume"] as const)(
    "uses inline feedback for a routine %s without recovery controls",
    async (action) => {
      const initial =
        action === "pause" ? snapshot() : snapshot([], { state: "paused", legalMoves: [] });
      const { api } = mount(initial);
      await act(() => vi.advanceTimersByTimeAsync(0));
      const response = Promise.withResolvers<GameSnapshot>();
      api.lifecycle.mockReturnValueOnce(response.promise);
      const control = screen.getByRole("button", { name: action === "pause" ? "Pause" : "Resume" });
      control.focus();
      fireEvent.click(control);
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Retry recovery" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry same command" })).not.toBeInTheDocument();
      expect(
        screen.queryByText(
          "Checking the accepted game state. Resolve any pending command before continuing.",
        ),
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByRole("group", { name: "AI playback controls" })).getByText(
          "Applying your game control…",
        ),
      ).toBeVisible();
      await act(async () => {
        response.resolve(
          snapshot(
            [],
            action === "pause" ? { state: "paused", legalMoves: [], version: 1 } : { version: 1 },
          ),
        );
      });
      expect(control).toHaveAttribute("aria-disabled", "false");
      expect(control).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Retry recovery" })).not.toBeInTheDocument();
    },
  );

  it("preserves actual recovery feedback and its retry control during an explicit command retry", async () => {
    const { api } = mount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    api.lifecycle.mockRejectedValueOnce(new ApiFailure("network"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });
    const retry = screen.getByRole("button", { name: "Retry same command" });
    const response = Promise.withResolvers<GameSnapshot>();
    api.lifecycle.mockReturnValueOnce(response.promise);
    retry.focus();
    fireEvent.click(retry);
    expect(screen.getByRole("button", { name: "Retry same command" })).toBe(retry);
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).toHaveFocus();
    expect(
      screen.getByText(
        "Checking the accepted game state. Resolve any pending command before continuing.",
      ),
    ).toBeVisible();
    await act(async () => {
      response.resolve(snapshot([], { state: "paused", legalMoves: [], version: 1 }));
    });
    expect(screen.queryByRole("button", { name: "Retry same command" })).not.toBeInTheDocument();
  });
});

describe("AI arena Stop confirmation", () => {
  it("preserves the dialog and focus across a move, then stops the latest revision during the next turn", async () => {
    const { api, turnApi, pending } = mount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Stop game" }));
    const dialog = screen.getByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    const nextTurn = Promise.withResolvers<GameSnapshot>();
    turnApi.turn.mockReturnValueOnce(nextTurn.promise);
    await act(async () => {
      pending.resolve(snapshot(["e2e4"]));
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(cancel).toHaveFocus();
    expect(turnApi.turn).toHaveBeenCalledTimes(2);
    api.lifecycle.mockResolvedValueOnce(
      snapshot(["e2e4"], {
        state: "aborted",
        terminationReason: "aborted",
        legalMoves: [],
        version: 2,
      }),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Stop game" }));
    });
    expect(api.lifecycle.mock.calls[0]?.[0]).toMatchObject({ action: "abort", expectedVersion: 1 });
    expect(turnApi.turn.mock.calls[1]?.[2].aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(turnApi.turn).toHaveBeenCalledTimes(2);
  });

  it.each(["completed", "access-error"] as const)("closes the dialog on %s", async (outcome) => {
    const { api, pending } = mount(snapshot(FOOLS_MATE.slice(0, 3)));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Stop game" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Stop game" });
    await act(async () => {
      if (outcome === "completed") pending.resolve(snapshot(FOOLS_MATE));
      else pending.reject(new ApiFailure("api", "UNAUTHORIZED"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(confirm);
    expect(api.lifecycle).not.toHaveBeenCalled();
  });

  it("does not carry the confirmation to another game", async () => {
    const { props, rerender, api } = mount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Stop game" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Stop game" });
    const other = snapshot([], { gameId: OTHER_GAME_ID });
    rerender(<GamePreview key={other.gameId} {...props} initial={other} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(confirm);
    expect(api.lifecycle).not.toHaveBeenCalled();
  });

  it("retains the dialog with confirmation disabled during recovery, keeping Cancel available", async () => {
    const { api, pending } = mount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Stop game" }));
    const dialog = screen.getByRole("dialog");
    api.snapshot.mockReturnValueOnce(new Promise<GameSnapshot>(() => undefined));
    fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Stop game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Checking the accepted game state",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve(snapshot(["e2e4"]));
    });
  });
});
