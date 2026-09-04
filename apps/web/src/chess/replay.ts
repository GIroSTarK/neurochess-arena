import type { ChessColor, GameReplayResponse } from "@neurochess/contracts";

import { parsePosition } from "./position";

/** A position presented in place of the accepted snapshot, such as a replay ply. */
export interface BoardView {
  readonly fen: string;
  readonly turn: ChessColor;
  readonly inCheck: boolean;
  readonly lastMove: string | undefined;
}

export function replayView(replay: GameReplayResponse, ply: number): BoardView | undefined {
  if (!Number.isInteger(ply) || ply < 0 || ply > replay.snapshot.moves.length) return undefined;
  const move = replay.snapshot.moves[ply - 1];
  const fen = move?.fen ?? replay.initialFen;
  const position = parsePosition(fen);
  if (!position) return undefined;
  return {
    fen,
    turn: position.turn,
    inCheck: move ? /[+#]$/.test(move.san) : false,
    lastMove: move?.uci,
  };
}
