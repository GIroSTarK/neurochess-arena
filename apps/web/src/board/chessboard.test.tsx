import type { ChessColor } from "@neurochess/contracts";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  CASTLING_APPROACH,
  EN_PASSANT_APPROACH,
  FOOLS_MATE,
  PROMOTION_APPROACH,
  snapshot,
} from "../test/fixtures";
import { square, squaresOnBoard } from "../test/queries";
import { renderLocalized } from "../test/render";

import { Chessboard } from "./chessboard";

function props(position = snapshot(), orientation: ChessColor = "white") {
  return {
    snapshot: position,
    orientation,
    canMove: true,
    interactionEpoch: "0",
    onMove: vi.fn(),
  };
}

describe("accessible chessboard", () => {
  it("provides eight rows, eight cells each, and one roving tab stop", () => {
    renderLocalized(<Chessboard {...props()} />);
    const grid = screen.getByRole("grid", { name: "Chessboard" });
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(8);
    for (const [index, row] of rows.entries()) {
      const cells = within(row).getAllByRole("gridcell");
      expect(cells).toHaveLength(8);
      for (const [file, cell] of cells.entries()) {
        expect(within(cell).getByRole("button")).toHaveAccessibleName(
          new RegExp(`^${"abcdefgh".charAt(file)}${8 - index}:`),
        );
      }
    }
    expect(
      within(grid)
        .getAllByRole("button")
        .filter((button) => button.tabIndex === 0),
    ).toEqual([square("e2")]);
    expect(square("e1")).toHaveAccessibleName("e1: White king.");
  });

  it.each(["white", "black"] as const)(
    "orders framed coordinates with %s at the bottom without adding grid cells or tab stops",
    (orientation) => {
      renderLocalized(<Chessboard {...props(snapshot(), orientation)} />);
      const grid = screen.getByRole("grid", { name: "Chessboard" });
      const files = screen.getAllByText(/^[a-h]$/);
      const ranks = screen.getAllByText(/^[1-8]$/).filter((label) => !grid.contains(label));
      expect(files.map((label) => label.textContent).join("")).toBe(
        orientation === "white" ? "abcdefgh" : "hgfedcba",
      );
      expect(ranks.map((label) => label.textContent).join("")).toBe(
        orientation === "white" ? "87654321" : "12345678",
      );
      for (const label of [...files, ...ranks]) {
        expect(grid).not.toContainElement(label);
        expect(label.closest('[aria-hidden="true"]')).not.toBeNull();
      }
      expect(within(grid).getAllByRole("gridcell")).toHaveLength(64);
      expect(screen.getAllByRole("button").filter((button) => button.tabIndex === 0)).toEqual([
        square("e2"),
      ]);
    },
  );

  it.each(["white", "black"] as const)(
    "keeps mobile rank annotations outside square button labels with %s at the bottom",
    (orientation) => {
      renderLocalized(<Chessboard {...props(snapshot(), orientation)} />);
      const grid = screen.getByRole("grid", { name: "Chessboard" });
      const ranks = within(grid).getAllByText(/^[1-8]$/);
      expect(ranks).toHaveLength(8);
      for (const rank of ranks) {
        expect(rank.closest("button")).toBeNull();
        expect(rank).toHaveAttribute("aria-hidden", "true");
      }
      expect(squaresOnBoard()(orientation === "white" ? "a1" : "h1")).toHaveAccessibleName(
        orientation === "white" ? "a1: White rook." : "h1: White rook.",
      );
    },
  );

  it.each(["white", "black"] as const)(
    "follows visible directions, row ends and corners with %s at the bottom",
    async (orientation) => {
      renderLocalized(<Chessboard {...props(snapshot(), orientation)} />);
      const square = squaresOnBoard();
      const user = userEvent.setup();
      act(() => square("e4").focus());
      await user.keyboard("{ArrowRight}");
      expect(square(orientation === "white" ? "f4" : "d4")).toHaveFocus();
      await user.keyboard("{ArrowUp}");
      expect(square(orientation === "white" ? "f5" : "d3")).toHaveFocus();
      await user.keyboard("{Home}");
      expect(square(orientation === "white" ? "a5" : "h3")).toHaveFocus();
      await user.keyboard("{End}");
      expect(square(orientation === "white" ? "h5" : "a3")).toHaveFocus();
      await user.keyboard("{Control>}{Home}{/Control}");
      expect(square(orientation === "white" ? "a8" : "h1")).toHaveFocus();
      await user.keyboard("{ArrowUp}{ArrowLeft}");
      expect(square(orientation === "white" ? "a8" : "h1")).toHaveFocus();
      await user.keyboard("{Control>}{End}{/Control}");
      expect(square(orientation === "white" ? "h1" : "a8")).toHaveFocus();
      await user.tab();
      expect(document.body).toHaveFocus();
    },
  );

  it("preserves the logical roving square and selection when flipped", async () => {
    const initial = props();
    const { rerender } = renderLocalized(<Chessboard {...initial} />);
    const square = squaresOnBoard();
    await userEvent.click(square("e2"));
    rerender(<Chessboard {...initial} orientation="black" />);
    expect(within(screen.getByRole("grid")).getByRole("button", { name: /^e2:/ })).toBe(
      square("e2"),
    );
    expect(square("e2")).toHaveAttribute("tabindex", "0");
    expect(square("e2")).toHaveAttribute("data-selected", "true");
    expect(within(screen.getByRole("grid")).getAllByRole("row")[0]).toHaveTextContent("1");
  });

  it("uses the same source-destination path for native keyboard and pointer activation", async () => {
    const initial = props();
    renderLocalized(<Chessboard {...initial} />);
    const square = squaresOnBoard();
    const user = userEvent.setup();
    act(() => square("e2").focus());
    await user.keyboard("{Enter}");
    expect(square("e3")).toHaveAccessibleName(/Legal destination/);
    await user.keyboard("{ArrowUp} ");
    expect(initial.onMove).toHaveBeenCalledExactlyOnceWith("e2e3");
  });

  it("scrolls a newly focused square into view but leaves an activated focused square in place", async () => {
    renderLocalized(<Chessboard {...props()} />);
    const square = squaresOnBoard();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    onTestFinished(() => scroll.mockRestore());
    const user = userEvent.setup();
    await user.click(square("e2"));
    expect(square("e2")).toHaveFocus();
    expect(square("e2")).toHaveAttribute("data-selected", "true");
    expect(scroll).not.toHaveBeenCalled();
    await user.keyboard("{ArrowUp}");
    expect(square("e3")).toHaveFocus();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
    expect(scroll.mock.contexts[0]).toBe(square("e3"));
  });

  it("cancels selection with Escape and ignores held activation keys", async () => {
    const initial = props();
    renderLocalized(<Chessboard {...initial} />);
    const square = squaresOnBoard();
    const user = userEvent.setup();
    await user.click(square("e2"));
    const repeated = new KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    square("e4").dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(true);
    expect(initial.onMove).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(square("e2")).not.toHaveAttribute("data-selected");
    expect(square("e4")).not.toHaveAttribute("data-target");
  });

  it("derives selections and targets only from the supplied legal move list", async () => {
    const initial = props(snapshot([], { legalMoves: ["e2e3"] }));
    renderLocalized(<Chessboard {...initial} />);
    const square = squaresOnBoard();
    await userEvent.click(square("d2"));
    expect(square("d2")).not.toHaveAttribute("data-selected");
    await userEvent.click(square("e2"));
    expect(square("e3")).toHaveAttribute("data-target", "move");
    expect(square("e4")).not.toHaveAttribute("data-target");
    await userEvent.click(square("e4"));
    expect(initial.onMove).not.toHaveBeenCalled();
  });

  it("keeps accepted pieces and focus while pending, then clears stale selection without moving focus", async () => {
    const initial = props();
    const { rerender } = renderLocalized(<Chessboard {...initial} />);
    const square = squaresOnBoard();
    const user = userEvent.setup();
    await user.click(square("e2"));
    await user.click(square("e4"));
    rerender(<Chessboard {...initial} canMove={false} />);
    expect(square("e2")).toHaveAccessibleName(/White pawn/);
    expect(square("e4")).toHaveAccessibleName(/empty/);
    expect(square("e4")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(square("d4")).toHaveFocus();
    await user.click(square("d2"));
    await user.click(square("d4"));
    expect(initial.onMove).toHaveBeenCalledTimes(1);
    rerender(<Chessboard {...initial} snapshot={snapshot(["e2e4"])} interactionEpoch="1" />);
    expect(square("d4")).toHaveFocus();
    expect(square("e4")).toHaveAccessibleName(/White pawn.*Last move/);
    expect(square("e2")).not.toHaveAttribute("data-selected");
  });

  it("clears selection on a same-version synchronization", async () => {
    const initial = props();
    const { rerender } = renderLocalized(<Chessboard {...initial} />);
    const square = squaresOnBoard();
    await userEvent.click(square("e2"));
    rerender(<Chessboard {...initial} interactionEpoch="1" />);
    expect(square("e2")).not.toHaveAttribute("data-selected");
    expect(square("e2")).toHaveFocus();
  });

  it("submits castling as the supplied king move and renders both accepted piece changes", async () => {
    const initial = props(snapshot(CASTLING_APPROACH));
    const { rerender } = renderLocalized(<Chessboard {...initial} />);
    const square = squaresOnBoard();
    await userEvent.click(square("e1"));
    expect(square("g1")).toHaveAttribute("data-target", "move");
    await userEvent.click(square("g1"));
    expect(initial.onMove).toHaveBeenCalledExactlyOnceWith("e1g1");
    rerender(<Chessboard {...initial} snapshot={snapshot([...CASTLING_APPROACH, "e1g1"])} />);
    expect(square("g1")).toHaveAccessibleName(/White king/);
    expect(square("f1")).toHaveAccessibleName(/White rook/);
    expect(square("h1")).toHaveAccessibleName(/empty/);
  });

  it("marks an empty en passant destination as a capture and renders the accepted removal", async () => {
    const initial = props(snapshot(EN_PASSANT_APPROACH));
    const { rerender } = renderLocalized(<Chessboard {...initial} />);
    const square = squaresOnBoard();
    await userEvent.click(square("e5"));
    expect(square("d6")).toHaveAttribute("data-target", "capture");
    expect(square("d6")).toHaveAccessibleName(/Legal en passant capture/);
    await userEvent.click(square("d6"));
    expect(initial.onMove).toHaveBeenCalledExactlyOnceWith("e5d6");
    rerender(<Chessboard {...initial} snapshot={snapshot([...EN_PASSANT_APPROACH, "e5d6"])} />);
    expect(square("d5")).toHaveAccessibleName(/empty/);
    expect(square("d6")).toHaveAccessibleName(/White pawn/);
  });

  it.each([
    ["white", "q", "Queen"],
    ["white", "r", "Rook"],
    ["white", "b", "Bishop"],
    ["white", "n", "Knight"],
    ["black", "q", "Queen"],
    ["black", "r", "Rook"],
    ["black", "b", "Bishop"],
    ["black", "n", "Knight"],
  ] as const)(
    "offers explicit %s promotion to %s without moving the accepted pawn early",
    async (color, suffix, label) => {
      const moves = color === "white" ? PROMOTION_APPROACH : [...PROMOTION_APPROACH, "b7a8n"];
      const source = color === "white" ? "b7" : "g2";
      const target = color === "white" ? "a8" : "h1";
      const initial = props(snapshot(moves));
      renderLocalized(<Chessboard {...initial} />);
      const square = squaresOnBoard();
      await userEvent.click(square(source));
      await userEvent.click(square(target));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAccessibleName(new RegExp(target));
      expect(within(dialog).getAllByRole("button")).toHaveLength(5);
      expect(initial.onMove).not.toHaveBeenCalled();
      expect(square(source)).toHaveAccessibleName(/pawn/);
      await userEvent.click(within(dialog).getByRole("button", { name: "Promote to " + label }));
      expect(initial.onMove).toHaveBeenCalledExactlyOnceWith(source + target + suffix);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(square(target)).toHaveFocus();
    },
  );

  it.each(["button", "Escape"])(
    "contains promotion focus and returns it on %s cancellation",
    async (cancelWith) => {
      const initial = props(snapshot(PROMOTION_APPROACH));
      renderLocalized(<Chessboard {...initial} />);
      const square = squaresOnBoard();
      const user = userEvent.setup();
      await user.click(square("b7"));
      await user.click(square("a8"));
      expect(screen.getByRole("button", { name: "Promote to Queen" })).toHaveFocus();
      await user.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "Promote to Queen" })).toHaveFocus();
      if (cancelWith === "Escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(square("b7")).toHaveAttribute("data-selected", "true");
      expect(square("a8")).toHaveFocus();
      expect(initial.onMove).not.toHaveBeenCalled();
    },
  );

  it.each(["paused", "completed", "aborted"] as const)(
    "permits inspection but locks movement for %s positions",
    async (state) => {
      const position =
        state === "completed"
          ? snapshot(FOOLS_MATE)
          : state === "aborted"
            ? snapshot([], { state, result: "*", terminationReason: "aborted", legalMoves: [] })
            : snapshot([], { state, legalMoves: [] });
      const initial = props(position);
      renderLocalized(<Chessboard {...initial} />);
      const square = squaresOnBoard();
      const user = userEvent.setup();
      expect(screen.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
      await user.click(square("e2"));
      await user.keyboard("{ArrowUp}{Enter}");
      expect(square("e3")).toHaveFocus();
      expect(initial.onMove).not.toHaveBeenCalled();
      if (state === "completed") expect(square("e1")).toHaveAccessibleName(/King in check/);
    },
  );

  it("renders a safe presentation error for invalid FEN", () => {
    renderLocalized(<Chessboard {...props({ ...snapshot(), fen: "<script>secret</script>" })} />);
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.getByText(/This position cannot be displayed/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret");
  });
});
