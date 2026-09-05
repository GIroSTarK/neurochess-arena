import type { ChessColor } from "@neurochess/contracts";

import type { Piece, Position, Square } from "./position";

export type SquareTarget = "move" | "capture" | "en-passant";

export interface SquareState {
  readonly square: Square;
  readonly piece: Piece | undefined;
  readonly dark: boolean;
  readonly selected: boolean;
  readonly target: SquareTarget | null;
  readonly lastMove: boolean;
  readonly kingInCheck: boolean;
}

export interface BoardMarks {
  readonly position: Position;
  readonly source: Square | null;
  readonly targets: ReadonlySet<Square>;
  /** The last accepted move in UCI, if any. */
  readonly lastMove: string | undefined;
  readonly checkedColor: ChessColor | null;
}

export function isDarkSquare(square: Square): boolean {
  return (square.charCodeAt(0) - 97 + Number(square[1])) % 2 === 1;
}

export function squareState(marks: BoardMarks, square: Square): SquareState {
  const { position, source, targets, lastMove, checkedColor } = marks;
  const piece = position.pieces.get(square);
  const sourcePiece = source === null ? undefined : position.pieces.get(source);
  const isTarget = targets.has(square);
  // A pawn reaching the en passant square from another file captures a pawn that is not there.
  const enPassant =
    isTarget &&
    piece === undefined &&
    sourcePiece?.kind === "p" &&
    square === position.enPassant &&
    source !== null &&
    !source.startsWith(square.charAt(0));
  return {
    square,
    piece,
    dark: isDarkSquare(square),
    selected: source === square,
    target: !isTarget ? null : enPassant ? "en-passant" : piece ? "capture" : "move",
    lastMove:
      lastMove !== undefined && (lastMove.startsWith(square) || lastMove.slice(2, 4) === square),
    kingInCheck: piece?.kind === "k" && piece.color === checkedColor,
  };
}
