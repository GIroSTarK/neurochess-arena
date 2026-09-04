import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { FOOLS_MATE, mockController, readyState, snapshot } from "../../test/fixtures";
import { renderLocalized } from "../../test/render";

import { PgnActions } from "./PgnActions";

function props() {
  const controller = mockController();
  return {
    controller,
    state: readyState({ snapshot: snapshot(FOOLS_MATE) }),
    exportPgn: controller.exportPgn,
  };
}

describe("PGN export focus", () => {
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

      rerender(<PgnActions {...initial} state={{ ...initial.state, exportPhase: "loading" }} />);
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

      rerender(<PgnActions {...initial} state={{ ...initial.state, exportPhase: outcome }} />);
      expect(control).toHaveAttribute("aria-disabled", "false");
      expect(control).toHaveFocus();
      expect(screen.getByText(message)).toBeInTheDocument();
    },
  );
});
