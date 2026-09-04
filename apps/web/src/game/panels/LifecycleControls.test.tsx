import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockController, OTHER_GAME_ID, readyState, snapshot } from "../../test/fixtures";
import { renderLocalized } from "../../test/render";

import { LifecycleControls } from "./LifecycleControls";

function props() {
  const controller = mockController();
  return { controller, state: readyState(), lifecycle: controller.lifecycle };
}

describe("lifecycle confirmations", () => {
  it.each([
    { name: "Abort game", confirm: "Stop game", action: { action: "abort" } },
    {
      name: "Resign White",
      confirm: "Confirm resignation",
      action: { action: "resign", losingColor: "white" },
    },
    {
      name: "Resign Black",
      confirm: "Confirm resignation",
      action: { action: "resign", losingColor: "black" },
    },
  ])(
    "invalidates an open $name confirmation after an accepted revision changes",
    async ({ name, confirm, action }) => {
      const initial = props();
      const { rerender } = renderLocalized(<LifecycleControls {...initial} />);
      const trigger = screen.getByRole("button", { name });
      await userEvent.click(trigger);
      const dialog = screen.getByRole("dialog");
      const staleConfirm = within(dialog).getByRole("button", { name: confirm });

      rerender(
        <LifecycleControls
          {...initial}
          state={{ ...initial.state, snapshot: snapshot(["e2e4"]) }}
        />,
      );

      expect(screen.getByRole("button", { name })).toBe(trigger);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(staleConfirm);
      expect(initial.lifecycle).not.toHaveBeenCalled();
      await userEvent.click(trigger);
      await userEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: confirm }),
      );
      expect(initial.lifecycle).toHaveBeenCalledExactlyOnceWith(action);
    },
  );

  it("invalidates a confirmation when the interaction epoch changes without a new snapshot", async () => {
    const initial = props();
    const { rerender } = renderLocalized(<LifecycleControls {...initial} />);
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(
      <LifecycleControls
        {...initial}
        state={{ ...initial.state, interactionRevision: initial.state.interactionRevision + 1 }}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(initial.lifecycle).not.toHaveBeenCalled();
  });

  it("does not carry a confirmation to another game at the same revision", async () => {
    const initial = props();
    const { rerender } = renderLocalized(<LifecycleControls {...initial} />);
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(
      <LifecycleControls
        {...initial}
        state={{ ...initial.state, snapshot: snapshot([], { gameId: OTHER_GAME_ID }) }}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(initial.lifecycle).not.toHaveBeenCalled();
  });

  it("keeps a current confirmation and its focus during unrelated renders", async () => {
    const initial = props();
    const { rerender } = renderLocalized(<LifecycleControls {...initial} />);
    await userEvent.click(screen.getByRole("button", { name: "Abort game" }));
    const dialog = screen.getByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    rerender(<LifecycleControls {...initial} state={{ ...initial.state }} />);

    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(cancel).toHaveFocus();
    expect(initial.lifecycle).not.toHaveBeenCalled();
  });
});
