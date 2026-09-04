import { gameReplayResponseSchema } from "@neurochess/contracts";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { FOOLS_MATE, mockController, readyState, snapshot } from "../../test/fixtures";
import { renderLocalized } from "../../test/render";

import { ReplayControls } from "./ReplayControls";

function props(replayPly: number) {
  const controller = mockController();
  const terminal = snapshot(FOOLS_MATE);
  const replay = gameReplayResponseSchema.parse({ snapshot: terminal, initialFen: snapshot().fen });
  return {
    controller,
    state: readyState({ snapshot: terminal, replay, replayPly }),
    selectPly: controller.selectPly,
  };
}

describe("replay navigation focus", () => {
  it.each(["loading", "error"] as const)(
    "shows the accepted final ply while replay is %s",
    (replayPhase) => {
      const initial = props(0);
      renderLocalized(
        <ReplayControls {...initial} state={{ ...initial.state, replay: null, replayPhase }} />,
      );
      expect(screen.getByText("Ply 4 of 4")).toBeInTheDocument();
    },
  );

  it.each([
    { name: "Next", from: 3, target: 4, alsoUnavailable: "Last", available: "Previous" },
    { name: "Previous", from: 1, target: 0, alsoUnavailable: "First", available: "Next" },
    { name: "First", from: 2, target: 0, alsoUnavailable: "Previous", available: "Last" },
    { name: "Last", from: 2, target: 4, alsoUnavailable: "Next", available: "First" },
  ])(
    "keeps focus on $name after it becomes unavailable",
    async ({ name, from, target, alsoUnavailable, available }) => {
      const initial = props(from);
      const { rerender } = renderLocalized(<ReplayControls {...initial} />);
      expect(screen.getByText(`Ply ${from} of 4`)).toBeInTheDocument();
      const user = userEvent.setup();
      const control = screen.getByRole("button", { name });
      act(() => control.focus());
      await user.keyboard("{Enter}");
      expect(initial.selectPly).toHaveBeenCalledExactlyOnceWith(target);

      rerender(<ReplayControls {...initial} state={{ ...initial.state, replayPly: target }} />);
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
      <ReplayControls
        {...initial}
        state={{ ...initial.state, replay: null, replayPhase: "loading" }}
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
