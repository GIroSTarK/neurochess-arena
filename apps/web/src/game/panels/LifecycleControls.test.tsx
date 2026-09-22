import { describe, expect, it, vi } from "vitest";

import { LifecycleControls as LifecyclePanel } from "../../arena/panels/LifecycleControls";
import {
  mockController,
  OTHER_GAME_ID,
  readyState,
  sandboxState,
  snapshot,
} from "../../test/fixtures";
import { renderLocalized } from "../../test/render";

import { LifecycleControls } from "./LifecycleControls";

vi.mock("../../arena/panels/LifecycleControls", () => ({ LifecycleControls: vi.fn(() => null) }));

function props() {
  return {
    controller: mockController(),
    state: readyState(),
    boardTools: { orientation: "white" as const, onFlip: vi.fn(), helpId: "board-help" },
  };
}

function panelProps() {
  const call = vi.mocked(LifecyclePanel).mock.lastCall;
  expect(call).toBeDefined();
  return call![0];
}

describe("Sandbox lifecycle mapping", () => {
  it("maps state, action colors and the localized guest-session explanation to shared controls", () => {
    const initial = props();
    const { rerender } = renderLocalized(<LifecycleControls {...initial} />);
    const panel = panelProps();
    expect(panel).toMatchObject({ paused: false, disabled: false });
    expect(panel.boardTools).toBe(initial.boardTools);
    expect(panel.abortDescription).toBe(
      "This ends the game without awarding a win or loss. Its moves remain available for replay and PGN export during your guest session.",
    );
    expect(panel.resignations.map(({ color }) => color)).toEqual(["white", "black"]);
    expect(initial.controller.lifecycle).not.toHaveBeenCalled();
    panel.onTogglePause!();
    panel.onAbort!();
    for (const seat of panel.resignations) seat.onResign();

    rerender(
      <LifecycleControls
        {...initial}
        state={readyState({ snapshot: snapshot([], { state: "paused", legalMoves: [] }) })}
      />,
    );
    expect(panelProps()).toMatchObject({ paused: true, disabled: false });
    panelProps().onTogglePause!();
    expect(initial.controller.lifecycle.mock.calls).toEqual([
      [{ action: "pause" }],
      [{ action: "abort" }],
      [{ action: "resign", losingColor: "white" }],
      [{ action: "resign", losingColor: "black" }],
      [{ action: "resume" }],
    ]);

    rerender(
      <LifecycleControls
        {...initial}
        state={sandboxState({ phase: "synchronizing", snapshot: snapshot(), pendingCommand: null })}
      />,
    );
    expect(panelProps().disabled).toBe(true);
  });

  it.each([
    { reason: "accepted revision", state: readyState({ snapshot: snapshot([], { version: 1 }) }) },
    {
      reason: "interaction revision without a new snapshot",
      state: readyState({ interactionRevision: 1 }),
    },
    {
      reason: "game identity at the same revision",
      state: readyState({ snapshot: snapshot([], { gameId: OTHER_GAME_ID }) }),
    },
  ])("changes the shared confirmation epoch for $reason", ({ state }) => {
    const initial = props();
    const { rerender } = renderLocalized(<LifecycleControls {...initial} />);
    const epoch = panelProps().epoch;

    rerender(<LifecycleControls {...initial} state={{ ...initial.state }} />);
    expect(panelProps().epoch).toBe(epoch);
    rerender(<LifecycleControls {...initial} state={state} />);
    expect(panelProps().epoch).not.toBe(epoch);
    expect(initial.controller.lifecycle).not.toHaveBeenCalled();
  });
});
