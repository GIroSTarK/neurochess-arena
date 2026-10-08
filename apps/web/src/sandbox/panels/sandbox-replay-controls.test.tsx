import { gameReplayResponseSchema } from "@neurochess/contracts";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { FOOLS_MATE, mockController, readyState, snapshot } from "../../test/fixtures";
import { renderLocalized } from "../../test/render";

import { SandboxReplayControls } from "./sandbox-replay-controls";

function props(replayPly: number) {
  const controller = mockController();
  const terminal = snapshot(FOOLS_MATE);
  const replay = gameReplayResponseSchema.parse({ snapshot: terminal, initialFen: snapshot().fen });
  return {
    controller,
    state: readyState({
      snapshot: terminal,
      replayState: { replay, replayPly, replayPhase: "idle", replayNotice: null },
    }),
    selectPly: controller.selectPly,
  };
}

describe("replay navigation focus", () => {
  it.each(["First", "Previous", "Next", "Last"])(
    "names %s without a redundant description before and after Escape",
    async (name) => {
      renderLocalized(<SandboxReplayControls {...props(2)} />);
      const user = userEvent.setup();
      const control = screen.getByRole("button", { name });
      expect(control).toHaveAccessibleName(name);
      expect(control).not.toHaveAccessibleDescription();

      act(() => control.focus());
      expect(control).toHaveAccessibleName(name);
      expect(control).not.toHaveAccessibleDescription();
      await user.keyboard("{Escape}");
      expect(control).toHaveFocus();
      expect(control).toHaveAccessibleName(name);
      expect(control).not.toHaveAccessibleDescription();
    },
  );

  it.each([
    { replay: null, replayPly: 0, replayPhase: "loading", replayNotice: null },
    { replay: null, replayPly: 0, replayPhase: "error", replayNotice: "network" },
  ] as const)("shows the accepted final ply while replay is $replayPhase", (replayState) => {
    const initial = props(0);
    renderLocalized(
      <SandboxReplayControls
        {...initial}
        state={readyState({ snapshot: snapshot(FOOLS_MATE), replayState })}
      />,
    );
    expect(screen.getByText("Ply 4 of 4")).toBeInTheDocument();
  });

  it.each([
    { name: "Next", from: 3, target: 4, alsoUnavailable: "Last", available: "Previous" },
    { name: "Previous", from: 1, target: 0, alsoUnavailable: "First", available: "Next" },
    { name: "First", from: 2, target: 0, alsoUnavailable: "Previous", available: "Last" },
    { name: "Last", from: 2, target: 4, alsoUnavailable: "Next", available: "First" },
  ])(
    "keeps focus on $name after it becomes unavailable",
    async ({ name, from, target, alsoUnavailable, available }) => {
      const initial = props(from);
      const { rerender } = renderLocalized(<SandboxReplayControls {...initial} />);
      expect(screen.getByText(`Ply ${from} of 4`)).toBeInTheDocument();
      const user = userEvent.setup();
      const control = screen.getByRole("button", { name });
      act(() => control.focus());
      await user.keyboard("{Enter}");
      expect(initial.selectPly).toHaveBeenCalledExactlyOnceWith(target);

      rerender(<SandboxReplayControls {...initial} state={props(target).state} />);
      expect(screen.getByText(`Ply ${target} of 4`)).toBeInTheDocument();
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).not.toBeDisabled();
      expect(control).toHaveFocus();
      await user.keyboard("{Enter} ");
      await user.click(control);
      expect(initial.selectPly).toHaveBeenCalledTimes(1);
      expect(control).toHaveFocus();
      expect(screen.getByRole("button", { name: alsoUnavailable })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.getByRole("button", { name: available })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
    },
  );

  it("keeps every control focusable while the replay is loading", async () => {
    const initial = props(0);
    renderLocalized(
      <SandboxReplayControls
        {...initial}
        state={readyState({
          snapshot: snapshot(FOOLS_MATE),
          replayState: {
            replay: null,
            replayPly: 0,
            replayPhase: "loading",
            replayNotice: null,
          },
        })}
      />,
    );
    const user = userEvent.setup();
    for (const name of ["First", "Previous", "Next", "Last"]) {
      await user.tab();
      const control = screen.getByRole("button", { name });
      expect(control).toHaveFocus();
      expect(control).toHaveAttribute("aria-disabled", "true");
    }
    await user.keyboard("{Enter}");
    expect(initial.selectPly).not.toHaveBeenCalled();
    expect(screen.getByText("Loading replay…")).toBeInTheDocument();
  });
});
