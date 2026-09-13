import type { BoardView } from "./replay";

// A presentation preview only; game creation and legal moves still come from the API.
export const standardPositionPreview: BoardView = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  turn: "white",
  inCheck: false,
  lastMove: undefined,
};
