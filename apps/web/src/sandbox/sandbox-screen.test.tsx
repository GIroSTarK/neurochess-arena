import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  FOOLS_MATE,
  GAME_ID,
  mockController,
  readyState,
  sandboxState,
  snapshot,
} from "../test/fixtures";
import { renderRouteScreen } from "../test/render";

import { SandboxScreen } from "./sandbox-screen";
import type { SandboxState } from "./state";

const sandbox = vi.hoisted(() => ({
  useSandbox: vi.fn<
    () => {
      state: SandboxState;
      controller: ReturnType<typeof mockController>;
      recover: () => void;
      checkReadiness: () => void;
    }
  >(),
}));

vi.mock("./use-sandbox", () => sandbox);

function renderSandbox(state: SandboxState = readyState()) {
  const controller = mockController();
  const checkReadiness = vi.fn();
  const actions = { controller, recover: controller.recover, checkReadiness };
  sandbox.useSandbox.mockReturnValue({ state, ...actions });
  const { rerender, ...rendered } = renderRouteScreen(
    <SandboxScreen apiBaseUrl="http://localhost:3001" />,
  );
  return {
    ...rendered,
    controller,
    checkReadiness,
    rerender: (nextState: SandboxState) => {
      sandbox.useSandbox.mockReturnValue({ state: nextState, ...actions });
      rerender(<SandboxScreen apiBaseUrl="http://localhost:3001" />);
    },
  };
}

const paused = () => snapshot([], { state: "paused", legalMoves: [], version: 1 });

describe("sandbox screen composition", () => {
  it("retains the header, rail feedback, move history, and board controls through lifecycle changes", () => {
    const { rerender } = renderSandbox();
    const details = within(screen.getByRole("complementary", { name: "Game details" }));
    const playArea = within(screen.getByRole("region", { name: "Play area" }));
    const feedback = details.getByTestId("status-feedback");
    const activity = within(feedback).getByTestId("activity-feedback");
    const history = details.getByRole("region", { name: "Move history" });
    const control = playArea.getByRole("button", { name: "Pause" });
    const summary = screen.getByRole("heading", { name: "White to move" });
    const paragraphs = () =>
      within(feedback)
        .queryAllByRole("paragraph")
        .map((p) => p.textContent);
    expect(paragraphs()).toEqual([]);
    expect(details.queryByRole("heading", { name: "White to move" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Game paused ·/ })).toBeNull();

    const pending = {
      action: "resume" as const,
      gameId: GAME_ID,
      expectedVersion: 1,
      commandId: crypto.randomUUID(),
    };
    rerender(readyState({ snapshot: paused() }));
    expect(paragraphs()).toEqual([]);
    expect(screen.getByRole("button", { name: "Resume" })).toBe(control);
    expect(screen.getByRole("heading", { name: /^Game paused ·/ })).toBe(summary);

    rerender(
      sandboxState({
        snapshot: paused(),
        phase: "submitting",
        pendingCommand: pending,
      }),
    );
    expect(paragraphs()).toEqual(["Applying your game command…"]);
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(activity).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { name: /^Game paused ·/ })).toBeInTheDocument();

    rerender(readyState());
    expect(details.getByTestId("status-feedback")).toBe(feedback);
    expect(within(feedback).getByTestId("activity-feedback")).toBe(activity);
    expect(details.getByRole("region", { name: "Move history" })).toBe(history);
    expect(playArea.getByRole("button", { name: "Pause" })).toBe(control);
    expect(screen.getByRole("heading", { name: "White to move" })).toBe(summary);
    expect(paragraphs()).toEqual([]);
  });

  it.each([
    ["existing", "Your current game is open."],
    ["recovered", "Game recovered. Resume when ready."],
    ["synchronized", "The accepted position is up to date."],
  ] as const)("composes the %s notice with paused recovery feedback", (notice, message) => {
    const { rerender } = renderSandbox(readyState({ snapshot: paused(), notice }));
    const details = within(screen.getByRole("complementary", { name: "Game details" }));
    const feedback = details.getByTestId("status-feedback");
    expect(
      within(feedback)
        .queryAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual(notice === "synchronized" ? [message] : []);
    if (notice !== "synchronized") {
      expect(details.getByRole("heading", { name: "Game recovered" })).toBeInTheDocument();
      expect(
        details.getByText("Your position and move history were restored."),
      ).toBeInTheDocument();
      expect(details.getByText("Resume when ready.")).toBeInTheDocument();
    }
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(
      sandboxState({ phase: "recovering", snapshot: paused(), pendingCommand: null }, { notice }),
    );
    expect(
      within(feedback)
        .getAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual(["Recovering your game…"]);
  });

  it("keeps error explanations and their synchronization feedback accessible", () => {
    const { rerender } = renderSandbox(
      sandboxState(
        { phase: "synchronizing", snapshot: snapshot(), pendingCommand: null },
        { notice: "ILLEGAL_MOVE" },
      ),
    );
    const details = within(screen.getByRole("complementary", { name: "Game details" }));
    const feedback = details.getByTestId("status-feedback");
    expect(
      within(feedback)
        .getAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual(["Checking the accepted position…"]);
    expect(screen.getByText("That move is no longer legal.")).toBeInTheDocument();
    rerender(readyState({ notice: "ILLEGAL_MOVE" }));
    expect(
      details
        .getAllByRole("paragraph")
        .filter((p) => p.textContent === "The accepted position is up to date."),
    ).toHaveLength(1);
  });

  it("retains actionable recovery and the terminal result without hidden interactive copies", () => {
    const { container, rerender } = renderSandbox(
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
    const details = within(screen.getByRole("complementary", { name: "Game details" }));
    const playArea = within(screen.getByRole("region", { name: "Play area" }));
    expect(details.getByRole("button", { name: "Check game status" })).toBeInTheDocument();
    expect(playArea.getByRole("button", { name: "Resume" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(container.querySelectorAll('[aria-hidden="true"] button')).toHaveLength(0);

    rerender(readyState({ snapshot: snapshot(FOOLS_MATE) }));
    expect(
      screen.getByRole("heading", { name: "Black wins by checkmate", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Result: 0-1")).toBeInTheDocument();
    expect(screen.getByText("0–1")).toHaveAttribute("aria-hidden", "true");
    expect(details.getByRole("button", { name: "New game" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    expect(screen.getAllByRole("button", { name: "New game" })).toHaveLength(1);
    expect(playArea.getByRole("button", { name: "First" })).toBeInTheDocument();
    expect(playArea.getByRole("button", { name: "Copy PGN" })).toBeInTheDocument();
    expect(playArea.getByRole("button", { name: "Download PGN" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Game controls" })).toBeNull();
    expect(container.querySelector("[data-testid=status-feedback]")).toBeNull();
    expect(container.querySelectorAll('[aria-hidden="true"] button')).toHaveLength(0);
  });

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
    {
      name: "Retry same command",
      method: "retryCommand",
      state: sandboxState(
        {
          phase: "uncertain",
          snapshot: paused(),
          pendingCommand: {
            gameId: GAME_ID,
            expectedVersion: 1,
            commandId: crypto.randomUUID(),
            action: "resume",
          },
        },
        { notice: "uncertain" },
      ),
    },
  ] as const)("routes $name to the controller", async ({ name, method, state }) => {
    const { controller } = renderSandbox(state);
    const details = within(screen.getByRole("complementary", { name: "Game details" }));
    await userEvent.click(details.getByRole("button", { name }));
    expect(controller[method]).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  {
    label: "Start sandbox",
    state: sandboxState({ phase: "entry", snapshot: null, pendingCommand: null }),
  },
  { label: "New game", state: readyState({ snapshot: snapshot(FOOLS_MATE) }) },
])("sandbox screen $label action", ({ label, state }) => {
  it.each(["checking", "unavailable"] as const)(
    "stays focusable but rejects activation while readiness is %s",
    async (readiness) => {
      const { controller, rerender, checkReadiness } = renderSandbox({ ...state, readiness });
      const control = screen.getByRole("button", { name: label });
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).not.toBeDisabled();
      const user = userEvent.setup();
      await user.click(control);
      expect(control).toHaveFocus();
      await user.keyboard("{Enter} ");
      expect(controller.start).not.toHaveBeenCalled();
      if (readiness === "unavailable") {
        await user.click(screen.getByRole("button", { name: "Retry connection" }));
        expect(checkReadiness).toHaveBeenCalledTimes(1);
      }
      rerender(state);
      expect(screen.getByRole("button", { name: label })).toBe(control);
      expect(control).toHaveAttribute("aria-disabled", "false");
      await user.click(control);
      expect(controller.start).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["starting", "recovering"] as const)(
    "stays focusable but rejects activation while %s",
    async (phase) => {
      const { controller, rerender } = renderSandbox(state);
      const control = screen.getByRole("button", { name: label });
      const user = userEvent.setup();
      await user.click(control);
      expect(controller.start).toHaveBeenCalledTimes(1);

      rerender(sandboxState({ phase, snapshot: state.snapshot, pendingCommand: null }));
      const pendingLabel =
        state.snapshot === null && phase === "starting" ? "Starting sandbox…" : label;
      expect(screen.getByRole("button", { name: pendingLabel })).toBe(control);
      expect(control).toHaveFocus();
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).not.toBeDisabled();
      await user.keyboard("{Enter} ");
      await user.click(control);
      expect(controller.start).toHaveBeenCalledTimes(1);

      rerender(state);
      expect(screen.getByRole("button", { name: label })).toBe(control);
      expect(control).toHaveAttribute("aria-disabled", "false");
      await user.keyboard("{Enter}");
      expect(controller.start).toHaveBeenCalledTimes(2);
    },
  );
});
