import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { snapshot } from "../test/fixtures";

import { MoveHistory } from "./MoveHistory";

describe("read-only SAN history", () => {
  it("groups White and Black by full move number and marks only the latest accepted ply", () => {
    const moves = snapshot(["e2e4", "e7e5", "g1f3"]).moves;
    render(<MoveHistory moves={moves} />);
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
    const { rerender } = render(<MoveHistory moves={first} />);
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
});
