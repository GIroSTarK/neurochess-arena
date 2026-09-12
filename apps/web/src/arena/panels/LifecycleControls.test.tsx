import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderLocalized } from "../../test/render";

import { LifecycleControls } from "./LifecycleControls";

describe("shared lifecycle capabilities", () => {
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
