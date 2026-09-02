import type { GameReplayResponse } from "@neurochess/contracts";

import type { BoardView } from "../board/Chessboard";
import { parsePosition } from "../board/position";

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
