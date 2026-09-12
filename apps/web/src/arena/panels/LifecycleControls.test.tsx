import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderLocalized } from "../../test/render";

import { LifecycleControls } from "./LifecycleControls";

describe("shared lifecycle capabilities", () => {
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
      resignations: [
        { color: "white" as const, onResign: resign },
        { color: "black" as const, onResign: resign },
      ],
      boardTools: { orientation: "white" as const, onFlip: flip, helpId: "board-help" },
    };
    const { rerender } = renderLocalized(<LifecycleControls {...props} />);
    expect(screen.getAllByRole("button")).toEqual(
      [
        "Pause",
        "Flip board",
        "Resign White",
        "Resign Black",
        "Keyboard controls",
        "Abort game",
      ].map((name) => screen.getByRole("button", { name })),
    );
    const pause = screen.getByRole("button", { name: "Pause" });
    await userEvent.click(pause);
    expect(togglePause).toHaveBeenCalledOnce();

    rerender(<LifecycleControls {...props} paused disabled />);
    expect(screen.getByRole("button", { name: "Resume" })).toBe(pause);
    expect(pause).toHaveFocus();
    await userEvent.keyboard("{Enter} ");
    expect(togglePause).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Flip board" }));
    expect(flip).toHaveBeenCalledOnce();
    const help = screen.getByRole("button", { name: "Keyboard controls" });
    await userEvent.click(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("board-help")).toBeVisible();
    await userEvent.click(help);
    expect(document.getElementById("board-help")).not.toBeVisible();
  });

  it("offers resignation only for the supplied human seat", async () => {
    const resign = vi.fn();
    renderLocalized(
      <LifecycleControls
        paused={false}
        disabled={false}
        epoch="match:1"
        resignations={[{ color: "black", onResign: resign }]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort game" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resign White" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Resign Black" }));
    expect(resign).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm resignation" }),
    );
    expect(resign).toHaveBeenCalledExactlyOnceWith();
  });

  it("dismisses a confirmation when its action is withdrawn without a new position", async () => {
    const abort = vi.fn();
    const props = { paused: false, disabled: false, epoch: "match:1", resignations: [] };
    const { rerender } = renderLocalized(<LifecycleControls {...props} onAbort={abort} />);
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    expect(screen.getByRole("dialog")).toBeVisible();

    rerender(<LifecycleControls {...props} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort game" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();

    rerender(<LifecycleControls {...props} onAbort={abort} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
