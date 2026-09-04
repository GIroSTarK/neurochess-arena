import type { GameSnapshot } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { EN_PASSANT_APPROACH, FOOLS_MATE, snapshot } from "../test/fixtures";

import { isSquare, parsePosition, type Square } from "./position";
import { type BoardMarks, isDarkSquare, squareState } from "./squares";

function marks(game: GameSnapshot, source: Square | null = null): BoardMarks {
  const position = parsePosition(game.fen);
  if (!position) throw new Error("Fixture position must parse");
  const moves = source ? game.legalMoves.filter((move) => move.startsWith(source)) : [];
  return {
    position,
    source,
    targets: new Set(moves.map((move) => move.slice(2, 4)).filter(isSquare)),
    lastMove: game.moves.at(-1)?.uci,
    checked: game.inCheck ? game.turn : null,
  };
}

describe("square state", () => {
  it("colors squares like a real board", () => {
    expect(isDarkSquare("a1")).toBe(true);
    expect(isDarkSquare("h1")).toBe(false);
    expect(isDarkSquare("a8")).toBe(false);
    expect(isDarkSquare("h8")).toBe(true);
    expect(isDarkSquare("e4")).toBe(false);
  });

  it("marks the selected piece and its plain and capturing destinations", () => {
    const board = marks(snapshot(["e2e4", "d7d5"]), "e4");
    expect(squareState(board, "e4")).toMatchObject({ selected: true, target: null });
    expect(squareState(board, "e5")).toMatchObject({ selected: false, target: "move" });
    expect(squareState(board, "d5").target).toBe("capture");
    expect(squareState(board, "e3").target).toBeNull();
  });

  it("recognizes an en passant capture onto an empty square", () => {
    const board = marks(snapshot(EN_PASSANT_APPROACH), "e5");
    expect(squareState(board, "d6")).toMatchObject({ piece: undefined, target: "en-passant" });
    expect(squareState(board, "e6").target).toBe("move");
  });

  it("marks the last move and only the checked king", () => {
    const board = marks(snapshot(FOOLS_MATE));
    expect(squareState(board, "d8").lastMove).toBe(true);
    expect(squareState(board, "h4").lastMove).toBe(true);
    expect(squareState(board, "e1")).toMatchObject({ lastMove: false, check: true });
    expect(squareState(board, "e8").check).toBe(false);
  });

  it("marks nothing on a fresh board without a selection", () => {
    const board = marks(snapshot());
    for (const square of ["a1", "e2", "e8"] as const) {
      expect(squareState(board, square)).toMatchObject({
        selected: false,
        target: null,
        lastMove: false,
        check: false,
      });
    }
  });
});
