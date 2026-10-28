import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderLocalized } from "../../test/render";

import { PlayerSummary } from "./player-summary";

const activity = { label: "Waiting", variants: ["Waiting", "To move"], isTurn: false };

describe("player identity disclosure", () => {
  it("restores the trigger when a pointer click does not focus buttons", async () => {
    renderLocalized(
      <>
        <button type="button">Other control</button>
        <PlayerSummary
          color="white"
          identity={{ kind: "human", name: "Alice" }}
          activity={activity}
        />
      </>,
    );
    screen.getByRole("button", { name: "Other control" }).focus();
    const trigger = screen.getByRole("button", { name: "View White identity: Alice" });
    // Native WebKit pointer activation does not focus a button automatically.
    fireEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("reveals complete identical model names by seat", async () => {
    const user = userEvent.setup();
    const identity = {
      kind: "ai",
      provider: "Example provider",
      model: "Identical-model-with-a-long-version-and-configuration-identifier".repeat(3),
    } as const;
    renderLocalized(
      <>
        <PlayerSummary color="white" identity={identity} activity={activity} />
        <PlayerSummary color="black" identity={identity} activity={activity} />
      </>,
    );
    for (const color of ["White", "Black"]) {
      const trigger = within(screen.getByLabelText(`${color} player`)).getByRole("button", {
        name: `View ${color} identity: ${identity.model}`,
      });
      await user.click(trigger);
      const dialog = screen.getByRole("dialog", { name: `${color} player` });
      expect(within(dialog).getByText(identity.model)).toBeVisible();
      expect(within(dialog).getByText(identity.provider)).toBeVisible();
      const close = within(dialog).getByRole("button", { name: "Close player identity" });
      expect(close).toHaveFocus();
      await user.tab();
      expect(close).toHaveFocus();
      await user.tab({ shift: true });
      expect(close).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    }
  });

  it("renders untrusted identities as text", async () => {
    const user = userEvent.setup();
    const name = '<img src="x" onerror="alert(1)">';
    const provider = "<script>untrusted provider</script>";
    const { rerender } = renderLocalized(
      <PlayerSummary color="white" identity={{ kind: "human", name }} activity={activity} />,
    );
    await user.click(screen.getByRole("button", { name: `View White identity: ${name}` }));
    expect(within(screen.getByRole("dialog")).getByText(name)).toBeVisible();
    expect(document.querySelector("img, script")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close player identity" }));
    rerender(
      <PlayerSummary
        color="white"
        identity={{ kind: "ai", model: name, provider }}
        activity={activity}
      />,
    );
    await user.click(screen.getByRole("button", { name: `View White identity: ${name}` }));
    expect(within(screen.getByRole("dialog")).getByText(provider)).toBeVisible();
    expect(document.querySelector("img, script")).toBeNull();
  });
});
