import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./dialog";

function Host({ onCancel }: { readonly onCancel: () => void }) {
  return (
    <Dialog title="Title" description="Description" onCancel={onCancel}>
      <button type="button">First</button>
      <button type="button">Last</button>
    </Dialog>
  );
}

describe("modal dialog primitive", () => {
  it("labels itself, moves focus inside, contains Tab, and restores the trigger on unmount", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const user = userEvent.setup();
    const { unmount } = render(<Host onCancel={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Title" });
    expect(dialog).toHaveAccessibleDescription("Description");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    unmount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("cancels on Escape and ignores held activation keys", async () => {
    const onCancel = vi.fn();
    render(<Host onCancel={onCancel} />);
    const first = screen.getByRole("button", { name: "First" });
    const repeated = new KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    first.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
