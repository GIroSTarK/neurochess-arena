import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./Button";

describe("button primitive", () => {
  it("keeps an unavailable button focusable and blocks keyboard and pointer activation", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" aria-disabled onClick={onClick}>
        Go
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    const user = userEvent.setup();
    await user.tab();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await user.keyboard("{Enter} ");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });

  it("activates once per press and ignores a held key", async () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <Button variant="secondary" onClick={onClick} onKeyDown={onKeyDown}>
        Go
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    act(() => button.focus());
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    for (const key of ["Enter", " "]) {
      const repeated = new KeyboardEvent("keydown", {
        key,
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(repeated);
      expect(repeated.defaultPrevented).toBe(true);
    }
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});
