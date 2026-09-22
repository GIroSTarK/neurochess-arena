import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderLocalized } from "../../test/render";

import { LifecycleControls } from "./LifecycleControls";

function confirmationProps() {
  return {
    paused: false,
    disabled: false,
    epoch: "match:1",
    onAbort: vi.fn(),
    abortDescription: "Stop this test match.",
    resignations: [
      { color: "white" as const, onResign: vi.fn() },
      { color: "black" as const, onResign: vi.fn() },
    ],
    boardTools: { orientation: "white" as const, onFlip: vi.fn(), helpId: "board-help" },
  };
}

describe("shared lifecycle capabilities", () => {
  it.each([
    { name: "Abort game", confirm: "Stop game", callback: "abort" },
    { name: "Resign White", confirm: "Confirm resignation", callback: "white" },
    { name: "Resign Black", confirm: "Confirm resignation", callback: "black" },
  ])(
    "invalidates an open $name confirmation when its epoch changes",
    async ({ name, confirm, callback }) => {
      const initial = confirmationProps();
      const { rerender } = renderLocalized(<LifecycleControls {...initial} />);
      const trigger = screen.getByRole("button", { name });
      await userEvent.click(trigger);
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
      const staleConfirm = within(dialog).getByRole("button", { name: confirm });

      rerender(<LifecycleControls {...initial} epoch="match:2" />);

      expect(screen.getByRole("button", { name })).toBe(trigger);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      fireEvent.click(staleConfirm);
      const callbacks = {
        abort: initial.onAbort,
        white: initial.resignations[0]!.onResign,
        black: initial.resignations[1]!.onResign,
      };
      for (const action of Object.values(callbacks)) expect(action).not.toHaveBeenCalled();
      await userEvent.click(trigger);
      await userEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: confirm }),
      );
      for (const [action, handler] of Object.entries(callbacks)) {
        expect(handler).toHaveBeenCalledTimes(action === callback ? 1 : 0);
      }
      expect(trigger).toHaveFocus();
    },
  );

  it("keeps a current confirmation and its focus during unrelated renders", async () => {
    const initial = confirmationProps();
    const { rerender } = renderLocalized(<LifecycleControls {...initial} />);
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    const dialog = screen.getByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    rerender(<LifecycleControls {...initial} boardTools={{ ...initial.boardTools }} />);

    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(cancel).toHaveFocus();
    expect(initial.onAbort).not.toHaveBeenCalled();
  });

  it("keeps the toolbar's logical order and permits inspection while game commands are locked", async () => {
    const togglePause = vi.fn();
    const abort = vi.fn();
    const resign = vi.fn();
    const flip = vi.fn();
    const props = {
      paused: false,
      disabled: false,
      epoch: "match:1",
      onTogglePause: togglePause,
      onAbort: abort,
      abortDescription: "Stop this test match.",
      resignations: [
        { color: "white" as const, onResign: resign },
        { color: "black" as const, onResign: resign },
      ],
      boardTools: { orientation: "white" as const, onFlip: flip, helpId: "board-help" },
    };
    const { rerender } = renderLocalized(<LifecycleControls {...props} />);
    const buttons = [
      "Pause",
      "Flip board",
      "Resign White",
      "Resign Black",
      "Keyboard controls",
      "Abort game",
    ].map((name) => screen.getByRole("button", { name }));
    expect(screen.getAllByRole("button")).toEqual(buttons);
    const user = userEvent.setup();
    for (const button of buttons) {
      await user.tab();
      expect(button).toHaveFocus();
    }
    const flipButton = screen.getByRole("button", { name: "Flip board" });
    expect(flipButton).toHaveAccessibleDescription("White at bottom");
    const help = screen.getByRole("button", { name: "Keyboard controls" });
    expect(help).toHaveAttribute("aria-expanded", "false");
    expect(help).toHaveAttribute("aria-controls", "board-help");
    expect(document.getElementById("board-help")).not.toBeVisible();
    const pause = screen.getByRole("button", { name: "Pause" });
    await userEvent.click(pause);
    expect(togglePause).toHaveBeenCalledOnce();

    rerender(
      <LifecycleControls
        {...props}
        paused
        disabled
        boardTools={{ ...props.boardTools, orientation: "black" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Resume" })).toBe(pause);
    expect(pause).toHaveFocus();
    expect(flipButton).toHaveAccessibleDescription("Black at bottom");
    await userEvent.keyboard("{Enter} ");
    expect(togglePause).toHaveBeenCalledOnce();
    for (const button of buttons.slice(1)) {
      await user.tab();
      expect(button).toHaveFocus();
    }
    for (const name of ["Resign White", "Resign Black"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      await user.click(button);
      await user.keyboard("{Enter} ");
    }
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    expect(resign).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Flip board" }));
    expect(flip).toHaveBeenCalledOnce();
    for (const button of buttons.slice(2, 5)) {
      await user.tab();
      expect(button).toHaveFocus();
    }
    await user.keyboard("{Enter}");
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("board-help")).toBeVisible();
    expect(help).toHaveFocus();
    rerender(<LifecycleControls {...props} paused disabled epoch="match:2" />);
    expect(flipButton).toHaveAccessibleDescription("White at bottom");
    expect(help).toHaveFocus();
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("board-help")).toBeVisible();
    await user.keyboard(" ");
    expect(help).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("board-help")).not.toBeVisible();
  });

  it.each(["white", "black"] as const)(
    "offers resignation only for the %s human seat",
    async (color) => {
      const resign = vi.fn();
      renderLocalized(
        <LifecycleControls
          paused={false}
          disabled={false}
          epoch="match:1"
          abortDescription="Stop this test match."
          resignations={[{ color, onResign: resign }]}
          boardTools={{ orientation: color, onFlip: vi.fn(), helpId: "board-help" }}
        />,
      );
      expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Abort game" })).toBeNull();
      const resignation = color === "white" ? "Resign White" : "Resign Black";
      expect(screen.getAllByRole("button")).toEqual(
        ["Flip board", resignation, "Keyboard controls"].map((name) =>
          screen.getByRole("button", { name }),
        ),
      );
      await userEvent.click(screen.getByRole("button", { name: resignation }));
      expect(resign).not.toHaveBeenCalled();
      await userEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm resignation" }),
      );
      expect(resign).toHaveBeenCalledExactlyOnceWith();
      expect(screen.getByRole("button", { name: resignation })).toHaveFocus();
    },
  );

  it("dismisses a confirmation when its action is withdrawn without a new position", async () => {
    const abort = vi.fn();
    const props = {
      paused: false,
      disabled: false,
      epoch: "match:1",
      resignations: [],
      abortDescription: "Stop this test match.",
      boardTools: { orientation: "white" as const, onFlip: vi.fn(), helpId: "board-help" },
    };
    const { rerender } = renderLocalized(<LifecycleControls {...props} onAbort={abort} />);
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(props.abortDescription);

    rerender(<LifecycleControls {...props} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort game" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toEqual(
      ["Flip board", "Keyboard controls"].map((name) => screen.getByRole("button", { name })),
    );

    rerender(<LifecycleControls {...props} onAbort={abort} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
