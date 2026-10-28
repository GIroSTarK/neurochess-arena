import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderLocalized } from "../test/render";

import { BoardTools } from "./board-tools";

describe("replay board inspection", () => {
  it.each([
    { orientation: "white", description: "White at bottom", flipped: "black" },
    { orientation: "black", description: "Black at bottom", flipped: "white" },
  ] as const)(
    "preserves keyboard order, focus, and help while flipping from $orientation",
    async ({ orientation, description, flipped }) => {
      const user = userEvent.setup();
      const onFlip = vi.fn();
      const props = { orientation, onFlip, helpId: "replay-help" };
      const { rerender } = renderLocalized(<BoardTools {...props} />);
      const flip = screen.getByRole("button", { name: "Flip board" });
      const help = screen.getByRole("button", { name: "Keyboard controls" });
      const instructions = document.getElementById("replay-help");
      const tools = screen.getByRole("group", { name: "Board tools" });
      expect(within(tools).getAllByRole("button")).toEqual([flip, help]);
      expect(screen.getAllByRole("button")).toEqual([flip, help]);
      expect(flip).toHaveAccessibleDescription(description);
      expect(help).toHaveAttribute("aria-controls", "replay-help");
      expect(help).toHaveAttribute("aria-expanded", "false");
      expect(instructions).not.toBeVisible();
      expect(instructions).toHaveTextContent("Use arrow keys to inspect squares.");

      await user.tab();
      expect(flip).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(onFlip).toHaveBeenCalledOnce();
      expect(flip).toHaveAccessibleDescription(description);
      await user.tab();
      expect(help).toHaveFocus();
      await user.keyboard(" ");
      expect(help).toHaveAttribute("aria-expanded", "true");
      expect(instructions).toBeVisible();
      expect(help).toHaveFocus();

      rerender(<BoardTools {...props} orientation={flipped} />);

      expect(screen.getByRole("button", { name: "Flip board" })).toBe(flip);
      expect(flip).toHaveAccessibleDescription(
        flipped === "white" ? "White at bottom" : "Black at bottom",
      );
      expect(help).toHaveFocus();
      expect(help).toHaveAttribute("aria-expanded", "true");
      expect(instructions).toBeVisible();
      await user.keyboard("{Enter}");
      expect(help).toHaveAttribute("aria-expanded", "false");
      expect(instructions).not.toBeVisible();
      await user.tab({ shift: true });
      expect(flip).toHaveFocus();
      await user.keyboard(" ");
      expect(onFlip).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps descriptions and help disclosures independent for separate boards", async () => {
    const user = userEvent.setup();
    renderLocalized(
      <>
        <section aria-label="White replay">
          <BoardTools orientation="white" onFlip={vi.fn()} helpId="white-help" />
        </section>
        <section aria-label="Black replay">
          <BoardTools orientation="black" onFlip={vi.fn()} helpId="black-help" />
        </section>
      </>,
    );
    const white = within(screen.getByRole("region", { name: "White replay" }));
    const black = within(screen.getByRole("region", { name: "Black replay" }));
    expect(white.getByRole("button", { name: "Flip board" })).toHaveAccessibleDescription(
      "White at bottom",
    );
    expect(black.getByRole("button", { name: "Flip board" })).toHaveAccessibleDescription(
      "Black at bottom",
    );
    await user.click(white.getByRole("button", { name: "Keyboard controls" }));
    expect(document.getElementById("white-help")).toBeVisible();
    expect(document.getElementById("black-help")).not.toBeVisible();
    expect(black.getByRole("button", { name: "Keyboard controls" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
