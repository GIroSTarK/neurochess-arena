import { createGameWithRules } from "../src/game.js";
import { type ChessGame, createGame, type DomainResult, type GameLifecycle } from "../src/index.js";
import { ChessRules } from "../src/rules.js";

export const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const KNIGHT_CYCLE = ["g1f3", "g8f6", "f3g1", "f6g8"] as const;
export const FOOLS_MATE = ["f2f3", "e7e5", "g2g4", "d8h4"] as const;
// Recorded quiet play from the standard position, with no earlier third occurrence.
// Keeping this static makes the restoration boundary test independent of move selection.
export const FIFTY_MOVE_HISTORY = [
  "b1a3 g8f6 a3b1 f6g4 b1a3 b8a6 a3b5 g4e5 b5d4 e5g4",
  "d4e6 a6c5 e6d4 c5a6 d4f3 a6b4 f3d4 b4d5 d4f5 g4f6",
  "f5h6 f6g4 g1f3 g4e3 a1b1 d5f6 f3e5 e3d5 h1g1 f6h5",
  "b1a1 h5f4 h6g8 d5b6 e5f3 a8b8 f3e5 f4d5 e5g6 d5f6",
  "a1b1 b6d5 b1a1 f6e4 g6f4 d5e3 f4g6 e4f6 g6f4 b8a8",
  "f4d3 a8b8 a1b1 f6g4 g1h1 g4f6 d3f4 b8a8 f4d5 e3g4",
  "g8h6 f6h5 h1g1 h8g8 d5c3 h5g3 c3d5 g8h8 d5f4 g4e3",
  "h6g8 e3g4 f4h5 g4h6 g1h1 a8b8 b1a1 g3f5 a1b1 f5e3",
  "h5g3 e3g4 b1a1 b8a8 a1b1 g4e5 g3f5 e5g6 b1a1 a8b8",
  "f5h4 g6e5 h4f5 e5g6 f5h4 h6g4 h4f5 g4e3 g8h6 e3c4",
]
  .join(" ")
  .split(" ");
export const ACTIVE: GameLifecycle = { state: "active", result: "*", terminationReason: null };

export function unwrap<T>(result: DomainResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Unexpected domain failure: ${result.error.code} at ply ${result.error.ply ?? "-"}`,
    );
  }
  return result.value;
}

/** Test-only FEN seam lives outside src and is never compiled or package-exported. */
export function position(fen: string): ChessGame {
  const game = createGameWithRules(new ChessRules(fen));
  unwrap(game.start());
  return game;
}

export function activeGame(): ChessGame {
  const game = createGame();
  unwrap(game.start());
  return game;
}

export function play(game: ChessGame, moves: readonly string[]): void {
  for (const move of moves) {
    unwrap(game.playMove(move));
  }
}

export function lifecycleOf(game: ChessGame): GameLifecycle {
  const { state, result, terminationReason } = game.snapshot();
  return { state, result, terminationReason } as GameLifecycle;
}
