import type { TFunction } from "i18next";

import type { SquareState } from "../position/squares";

/** The accessible name of a square: coordinate, occupant, and every applicable mark. */
export function squareLabel(state: SquareState, t: TFunction): string {
  const { square, piece, target } = state;
  return [
    piece
      ? t("board.occupied", { square, piece: t(`pieces.${piece.color}.${piece.kind}`) })
      : t("board.empty", { square }),
    state.selected ? t("board.selected") : "",
    target === "en-passant"
      ? t("board.enPassantTarget")
      : target === "capture"
        ? t("board.captureTarget")
        : target === "move"
          ? t("board.legalTarget")
          : "",
    state.lastMove ? t("board.lastMove") : "",
    state.kingInCheck ? t("board.inCheck") : "",
  ]
    .filter(Boolean)
    .join(" ");
}
