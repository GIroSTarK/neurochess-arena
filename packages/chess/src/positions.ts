import { failure, success } from "./result.js";
import { ChessRules } from "./rules.js";
import type { ChessColor, DomainResult, TerminationReason } from "./types.js";

export interface ReplayedPosition {
  readonly ply: number;
  readonly fen: string;
  readonly turn: ChessColor;
  readonly terminationReason: TerminationReason | null;
}

// Iteration lets browser consumers yield between prefixes without constructing
// PGN, full histories or playable-move projections at every intermediate ply.
export function* replayPositions(
  moves: readonly string[],
): Generator<DomainResult<ReplayedPosition>> {
  if (!Array.isArray(moves)) {
    yield failure("INVALID_HISTORY");
    return;
  }
  const entries = Array.from(moves as readonly unknown[]);
  const rules = new ChessRules();
  let outcome = rules.outcome();
  yield success({
    ply: 0,
    fen: rules.fen(),
    turn: rules.turn(),
    terminationReason: outcome?.terminationReason ?? null,
  });
  for (const [index, uci] of entries.entries()) {
    const ply = index + 1;
    if (outcome !== null || typeof uci !== "string" || !rules.playMove(uci, ply).ok) {
      yield failure("INVALID_HISTORY", ply);
      return;
    }
    outcome = rules.outcome();
    yield success({
      ply,
      fen: rules.fen(),
      turn: rules.turn(),
      terminationReason: outcome?.terminationReason ?? null,
    });
  }
}
