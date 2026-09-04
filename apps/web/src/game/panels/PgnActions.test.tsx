import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { FOOLS_MATE, mockController, readyState, snapshot } from "../../test/fixtures";
import { renderLocalized } from "../../test/render";

import { PgnActions } from "./PgnActions";
import { ReplayControls } from "./ReplayControls";

function props() {
  const controller = mockController();
  return {
    controller,
    state: readyState({ snapshot: snapshot(FOOLS_MATE) }),
    exportPgn: controller.exportPgn,
  };
}

describe("PGN export", () => {
  it("keeps replay and export errors in their own panels", () => {
    const { controller } = props();
    const failed = readyState({
      snapshot: snapshot(FOOLS_MATE),
      replayState: {
        replay: null,
        replayPly: 0,
        replayPhase: "error",
        replayNotice: "network",
      },
      exportState: { exportPhase: "error", exportText: null, exportNotice: "timeout" },
    });
    renderLocalized(
      <>
        <ReplayControls state={failed} controller={controller} />
        <PgnActions state={failed} controller={controller} />
      </>,
    );
    const replay = within(screen.getByRole("region", { name: "Replay" }));
    const pgn = within(screen.getByRole("region", { name: "Private PGN" }));
    const replayError = "The service could not be reached. Check your connection and try again.";
    const exportError = "The request took too long. Please try again.";
    expect(replay.getByText(replayError)).toBeInTheDocument();
    expect(replay.queryByText(exportError)).not.toBeInTheDocument();
    expect(pgn.getByText(exportError)).toBeInTheDocument();
    expect(pgn.queryByText(replayError)).not.toBeInTheDocument();
  });
  it.each([
    { name: "Copy PGN", action: "copy", outcome: "copied", message: "PGN copied." },
    {
      name: "Download PGN",
      action: "download",
      outcome: "downloaded",
      message: "PGN download started.",
    },
  ] as const)(
    "keeps focus on $name while the export is prepared",
    async ({ name, action, outcome, message }) => {
      const initial = props();
      const { rerender } = renderLocalized(<PgnActions {...initial} />);
      const user = userEvent.setup();
      const control = screen.getByRole("button", { name });
      act(() => control.focus());
      await user.keyboard("{Enter}");
      expect(initial.exportPgn).toHaveBeenCalledExactlyOnceWith(action);

      rerender(
        <PgnActions
          {...initial}
          state={readyState({
            snapshot: snapshot(FOOLS_MATE),
            exportState: { exportPhase: "loading", exportText: null, exportNotice: null },
          })}
        />,
      );
      for (const label of ["Copy PGN", "Download PGN"]) {
        const button = screen.getByRole("button", { name: label });
        expect(button).toHaveAttribute("aria-disabled", "true");
        expect(button).not.toBeDisabled();
      }
      expect(control).toHaveFocus();
      expect(screen.getByText("Preparing PGN…")).toBeInTheDocument();
      await user.keyboard("{Enter} ");
      await user.click(control);
      expect(initial.exportPgn).toHaveBeenCalledTimes(1);

      rerender(
        <PgnActions
          {...initial}
          state={readyState({
            snapshot: snapshot(FOOLS_MATE),
            exportState: { exportPhase: outcome, exportText: null, exportNotice: null },
          })}
        />,
      );
      expect(control).toHaveAttribute("aria-disabled", "false");
      expect(control).toHaveFocus();
      expect(screen.getByText(message)).toBeInTheDocument();
    },
  );
});
