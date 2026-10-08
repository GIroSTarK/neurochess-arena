import type { ChessColor, GameSnapshot, MoveRecord } from "@neurochess/contracts";

export function isTerminal(snapshot: Pick<GameSnapshot, "state">): boolean {
  return snapshot.state === "completed" || snapshot.state === "aborted";
}

export function isUnfinished(snapshot: Pick<GameSnapshot, "state">): boolean {
  return snapshot.state === "active" || snapshot.state === "paused";
}

/**
 * Combines the accepted position with client-side invalidation. Changes discard board
 * selection and open confirmations.
 */
export function interactionEpoch({
  snapshot,
  interactionRevision,
}: {
  readonly snapshot: Pick<GameSnapshot, "gameId" | "version"> | null;
  readonly interactionRevision: number;
}): string {
  return (snapshot ? snapshot.gameId + ":" + snapshot.version : "none") + ":" + interactionRevision;
}

type Equality<T> = (a: T, b: T) => boolean;

// The undefined guard only narrows the index access; neither list ever holds undefined.
function sameList<T>(a: readonly T[], b: readonly T[], same: Equality<T>): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return other !== undefined && same(item, other);
    })
  );
}

const moveFields = {
  ply: (a, b) => a.ply === b.ply,
  uci: (a, b) => a.uci === b.uci,
  san: (a, b) => a.san === b.san,
  fen: (a, b) => a.fen === b.fen,
} satisfies Record<keyof MoveRecord, Equality<MoveRecord>>;

// Every contract field is listed, so adding one to the schema fails to compile until it is compared.
const snapshotFields = {
  gameId: (a, b) => a.gameId === b.gameId,
  version: (a, b) => a.version === b.version,
  state: (a, b) => a.state === b.state,
  result: (a, b) => a.result === b.result,
  terminationReason: (a, b) => a.terminationReason === b.terminationReason,
  turn: (a, b) => a.turn === b.turn,
  inCheck: (a, b) => a.inCheck === b.inCheck,
  fen: (a, b) => a.fen === b.fen,
  pgn: (a, b) => a.pgn === b.pgn,
  legalMoves: (a, b) => sameList(a.legalMoves, b.legalMoves, (x, y) => x === y),
  moves: (a, b) =>
    sameList(a.moves, b.moves, (x, y) => Object.values(moveFields).every((same) => same(x, y))),
} satisfies Record<keyof GameSnapshot, Equality<GameSnapshot>>;

/** Whether two validated snapshots describe the same accepted state, whatever their key order. */
export function sameSnapshot(a: GameSnapshot, b: GameSnapshot): boolean {
  return Object.values(snapshotFields).every((same) => same(a, b));
}

/** Move records are one-based: White plays the first ply. */
export function plyColor(ply: number): ChessColor {
  return ply % 2 === 1 ? "white" : "black";
}
