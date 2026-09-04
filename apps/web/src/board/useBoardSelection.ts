import { useState } from "react";

import { isSquare, type Square } from "../position/position";

export interface Promotion {
  readonly destination: Square;
  /** The legal moves reaching the destination, one per promotion piece. */
  readonly moves: readonly string[];
}

interface Selection {
  readonly epoch: string;
  readonly source: Square;
  readonly promotion: Promotion | null;
}

export interface BoardSelection {
  /** The square of the selected piece, if any. */
  readonly source: Square | null;
  /** Destinations of the selected piece's legal moves. */
  readonly targets: ReadonlySet<Square>;
  readonly promotion: Promotion | null;
  /** Selects a movable piece, confirms a destination, or clears the selection. */
  readonly activate: (square: Square) => void;
  readonly clear: () => void;
  readonly cancelPromotion: () => void;
  /** Submits the chosen promotion move. */
  readonly choose: (move: string) => void;
}

export interface BoardSelectionOptions {
  readonly legalMoves: readonly string[];
  /** Selection and promotion are discarded when this changes. */
  readonly epoch: string;
  readonly enabled: boolean;
  readonly onMove: (move: string) => void;
}

/** Selection state derived only from the supplied legal moves; the board never infers legality. */
export function useBoardSelection({
  legalMoves,
  epoch,
  enabled,
  onMove,
}: BoardSelectionOptions): BoardSelection {
  const [selection, setSelection] = useState<Selection | null>(null);
  const selected = selection?.epoch === epoch ? selection : null;
  const selectedMoves = selected
    ? legalMoves.filter((move) => move.startsWith(selected.source))
    : [];
  return {
    source: selected?.source ?? null,
    targets: new Set(selectedMoves.map((move) => move.slice(2, 4)).filter(isSquare)),
    promotion: selected?.promotion ?? null,
    activate(square) {
      if (!enabled) return;
      const moves = selectedMoves.filter((move) => move.slice(2, 4) === square);
      if (selected && moves.length > 0) {
        if (moves.some((move) => move.length === 5)) {
          setSelection({ ...selected, promotion: { destination: square, moves } });
        } else if (moves[0]) {
          onMove(moves[0]);
        }
      } else if (legalMoves.some((move) => move.startsWith(square))) {
        setSelection(
          selected?.source === square ? null : { epoch, source: square, promotion: null },
        );
      } else {
        setSelection(null);
      }
    },
    clear: () => setSelection(null),
    cancelPromotion() {
      if (selected) setSelection({ ...selected, promotion: null });
    },
    choose(move) {
      if (selected) setSelection({ ...selected, promotion: null });
      onMove(move);
    },
  };
}
