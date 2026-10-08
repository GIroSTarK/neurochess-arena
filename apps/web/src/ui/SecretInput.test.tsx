import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SecretInput } from "./SecretInput";

const labels = { "aria-label": "Secret", showLabel: "Show secret", hideLabel: "Hide secret" };

describe("secret input privacy", () => {
  it.each(["inline", "stacked", "icon"] as const)(
    "masks an empty %s input and masks again after clearing",
    async (layout) => {
      render(<SecretInput {...labels} layout={layout} />);
      const input = screen.getByLabelText("Secret");
      const user = userEvent.setup();
      const show = screen.getByRole("button", { name: "Show secret" });
      expect(show).toHaveAttribute("aria-disabled", "true");
      await user.click(show);
      expect(input).toHaveAttribute("type", "password");
      await user.type(input, "test-only-secret");
      await user.click(show);
      expect(input).toHaveAttribute("type", "text");
      expect(show).toHaveAttribute("aria-controls", input.id);
      expect(show).toHaveAttribute("aria-pressed", "true");
      await user.clear(input);
      await user.type(input, "replacement");
      expect(input).toHaveAttribute("type", "password");
    },
  );

  it.each(["form reset", "owner input event"])(
    "masks and disables reveal after %s",
    async (clear) => {
      render(
        <form aria-label="Secret form">
          <SecretInput {...labels} name="secret" autoComplete="current-password" />
        </form>,
      );
      const input = screen.getByLabelText<HTMLInputElement>("Secret");
      const user = userEvent.setup();
      await user.type(input, "test-only-secret");
      await user.click(screen.getByRole("button", { name: "Show secret" }));
      expect(new FormData(input.form!).get("secret")).toBe("test-only-secret");
      act(() => {
        if (clear === "form reset") screen.getByRole<HTMLFormElement>("form").reset();
        else {
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      expect(input).toHaveValue("");
      expect(input).toHaveAttribute("type", "password");
      expect(screen.getByRole("button", { name: "Show secret" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    },
  );

  it("masks on a new visibility epoch without discarding the value or disabling later reveal", async () => {
    const view = render(<SecretInput {...labels} />);
    const input = screen.getByLabelText("Secret");
    const user = userEvent.setup();
    await user.type(input, "test-only-secret");
    await user.click(screen.getByRole("button", { name: "Show secret" }));
    view.rerender(<SecretInput {...labels} maskEpoch={1} />);
    expect(input).toHaveValue("test-only-secret");
    expect(input).toHaveAttribute("type", "password");
    view.rerender(<SecretInput {...labels} maskEpoch={1} readOnly />);
    await user.click(screen.getByRole("button", { name: "Show secret" }));
    expect(input).toHaveAttribute("type", "password");
    view.rerender(<SecretInput {...labels} maskEpoch={1} />);
    await user.click(screen.getByRole("button", { name: "Show secret" }));
    expect(input).toHaveAttribute("type", "text");
  });
});
