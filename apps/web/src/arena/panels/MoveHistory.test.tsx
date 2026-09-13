import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { snapshot } from "../../test/fixtures";
import { renderLocalized } from "../../test/render";

import { MoveHistory } from "./MoveHistory";

describe("shared SAN history rail", () => {
  it("labels the empty history and keeps its scroll area keyboard reachable", () => {
    renderLocalized(<MoveHistory moves={[]} />);
    const history = within(screen.getByRole("region", { name: "Moves" }));
    expect(history.getByRole("heading", { name: "Moves", level: 2 })).toBeInTheDocument();
    expect(history.getByRole("region", { name: "Move history" })).toHaveAttribute("tabindex", "0");
    const table = history.getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(table).getByRole("cell")).toHaveAttribute("colspan", "3");
    expect(within(table).getByText("Your first move starts the story.")).toBeInTheDocument();
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
  });

  it("groups White and Black by full move number and marks only the latest accepted ply", () => {
    const moves = snapshot(["e2e4", "e7e5", "g1f3"]).moves;
    renderLocalized(<MoveHistory moves={moves} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("1.e4e5");
    expect(rows[2]).toHaveTextContent("2.Nf3");
    expect(table.querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(table.querySelector("[aria-current]")).toHaveTextContent("Nf3");
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
  });

  it("preserves the reader's scroll position and follows new moves only at the bottom", () => {
    const first = snapshot(["e2e4"]).moves;
    const { rerender } = renderLocalized(<MoveHistory moves={first} />);
    const scroller = screen.getByRole("region", { name: "Move history" });
    let height = 1000;
    Object.defineProperties(scroller, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 200 },
    });
    fireEvent.scroll(scroller, { target: { scrollTop: 120 } });
    rerender(<MoveHistory moves={snapshot(["e2e4", "e7e5"]).moves} />);
    expect(scroller.scrollTop).toBe(120);
    fireEvent.scroll(scroller, { target: { scrollTop: 800 } });
    height = 1040;
    rerender(<MoveHistory moves={snapshot(["e2e4", "e7e5", "g1f3"]).moves} />);
    expect(scroller.scrollTop).toBe(1040);
  });

  it("keeps tabbed replay history named and selects SAN by keyboard without owning the cursor", async () => {
    const moves = snapshot(["e2e4", "e7e5", "g1f3"]).moves;
    const onSelect = vi.fn();
    const { rerender } = renderLocalized(
      <MoveHistory moves={moves} selectedPly={0} onSelect={onSelect} showHeading={false} />,
    );
    const history = screen.getByRole("region", { name: "Moves" });
    const first = within(history).getByRole("button", { name: "View ply 1: e4" });
    first.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(1);
    expect(first).toHaveFocus();
    expect(history.querySelector("[aria-current]")).toBeNull();

    rerender(<MoveHistory moves={moves} selectedPly={1} onSelect={onSelect} showHeading={false} />);
    expect(first).toHaveAttribute("aria-current", "step");
    expect(history.querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(first).toHaveFocus();
    expect(within(history).getByRole("button", { name: "View ply 3: Nf3" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
