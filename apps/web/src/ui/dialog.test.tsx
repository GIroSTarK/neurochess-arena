import { render, screen, within } from "@testing-library/react";
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
  it("retains closed content inertly and restores focus on every close and reopen", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const user = userEvent.setup();
    const content = (open: boolean) => (
      <Dialog open={open} title="Retained form" description="Private input" onCancel={vi.fn()}>
        <input aria-label="Secret" type="password" />
        <button type="button">Last</button>
      </Dialog>
    );
    const { rerender, unmount } = render(content(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    rerender(content(true));
    const dialog = screen.getByRole("dialog", { name: "Retained form" });
    const input = within(dialog).getByLabelText("Secret");
    expect(input).toHaveFocus();
    await user.type(input, "fixture-value");
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Last" })).toHaveFocus();
    rerender(content(false));
    expect(dialog).toHaveAttribute("inert");
    expect(dialog).not.toHaveAttribute("open");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    rerender(content(true));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByLabelText("Secret")).toBe(input);
    expect(input).toHaveValue("fixture-value");
    expect(input).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

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
