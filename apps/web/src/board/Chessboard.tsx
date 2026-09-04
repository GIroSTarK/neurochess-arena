import type { ChessColor, GameSnapshot } from "@neurochess/contracts";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { parsePosition, type PromotionKind, type Square, visualRows } from "../chess/position";
import type { BoardView } from "../chess/replay";
import { type BoardMarks, squareState } from "../chess/squares";

import { BoardSquare } from "./BoardSquare";
import { squareLabel } from "./labels";
import { PromotionDialog } from "./PromotionDialog";
import { useBoardSelection } from "./useBoardSelection";

interface ChessboardProps {
  readonly snapshot: GameSnapshot;
  readonly orientation: ChessColor;
  readonly canMove: boolean;
  /** Selection and promotion are discarded when this changes. */
  readonly interactionEpoch: string;
  readonly onMove: (move: string) => void;
  /** Id of the element holding the keyboard instructions. */
  readonly describedBy?: string | undefined;
  /** A position to present instead of the accepted snapshot; it disables moves. */
  readonly view?: BoardView | undefined;
}

const promotionOrder: readonly PromotionKind[] = ["q", "r", "b", "n"];

/**
 * The 8x8 grid with one roving tab stop. Presentation comes from the accepted snapshot or the
 * supplied view; only the snapshot's legal moves make squares selectable.
 */
export function Chessboard({
  snapshot,
  orientation,
  canMove,
  interactionEpoch,
  onMove,
  describedBy,
  view,
}: ChessboardProps) {
  const { t } = useTranslation();
  const fen = view?.fen ?? snapshot.fen;
  const position = useMemo(() => parsePosition(fen), [fen]);
  const rows = useMemo(() => visualRows(orientation), [orientation]);
  const buttons = useRef(new Map<Square, HTMLButtonElement>());
  const [focusedSquare, setFocusedSquare] = useState<Square>("e2");
  const enabled = !view && canMove && snapshot.state === "active" && position !== null;
  const selection = useBoardSelection({
    legalMoves: snapshot.legalMoves,
    epoch: interactionEpoch,
    enabled,
    onMove,
  });

  function focus(square: Square) {
    setFocusedSquare(square);
    buttons.current.get(square)?.focus();
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, row: number, column: number) {
    if ((event.key === "Enter" || event.key === " ") && event.repeat) {
      event.preventDefault();
      return;
    }
    let nextRow = row;
    let nextColumn = column;
    switch (event.key) {
      case "ArrowUp":
        nextRow = Math.max(0, row - 1);
        break;
      case "ArrowDown":
        nextRow = Math.min(7, row + 1);
        break;
      case "ArrowLeft":
        nextColumn = Math.max(0, column - 1);
        break;
      case "ArrowRight":
        nextColumn = Math.min(7, column + 1);
        break;
      case "Home":
        nextColumn = 0;
        if (event.ctrlKey) nextRow = 0;
        break;
      case "End":
        nextColumn = 7;
        if (event.ctrlKey) nextRow = 7;
        break;
      case "Escape":
        event.preventDefault();
        selection.clear();
        return;
      default:
        return;
    }
    event.preventDefault();
    const nextSquare = rows[nextRow]?.[nextColumn];
    if (nextSquare) focus(nextSquare);
  }

  if (!position) return <p>{t("board.invalidPosition")}</p>;

  const inCheck = view?.inCheck ?? snapshot.inCheck;
  const marks: BoardMarks = {
    position,
    source: selection.source,
    targets: selection.targets,
    lastMove: view ? view.lastMove : snapshot.moves.at(-1)?.uci,
    checked: inCheck ? (view?.turn ?? snapshot.turn) : null,
  };
  const { promotion } = selection;

  return (
    <>
      <div
        className="flex aspect-square w-full touch-manipulation flex-col outline-1 outline-control-border"
        role="grid"
        aria-label={t("board.label")}
        aria-describedby={describedBy}
        aria-readonly={!enabled}
        aria-rowcount={8}
        aria-colcount={8}
        data-orientation={orientation}
        data-fen={fen}
      >
        {rows.map((row, rowIndex) => (
          <div
            className="grid min-h-0 flex-1 grid-cols-8"
            role="row"
            key={row[0]?.[1]}
            aria-rowindex={rowIndex + 1}
          >
            {row.map((square, columnIndex) => {
              const state = squareState(marks, square);
              return (
                <BoardSquare
                  key={square}
                  state={state}
                  label={squareLabel(state, t)}
                  column={columnIndex + 1}
                  focusable={focusedSquare === square}
                  showRank={columnIndex === 0}
                  showFile={rowIndex === 7}
                  ref={(element) => {
                    if (element) buttons.current.set(square, element);
                    else buttons.current.delete(square);
                  }}
                  onFocus={() => setFocusedSquare(square)}
                  onActivate={() => {
                    focus(square);
                    selection.activate(square);
                  }}
                  onKeyDown={(event) => navigate(event, rowIndex, columnIndex)}
                />
              );
            })}
          </div>
        ))}
      </div>
      {promotion && enabled ? (
        <PromotionDialog
          color={snapshot.turn}
          destination={promotion.destination}
          choices={promotionOrder.flatMap((kind) => {
            const move = promotion.moves.find((candidate) => candidate[4] === kind);
            return move ? [{ kind, move }] : [];
          })}
          onCancel={selection.cancelPromotion}
          onChoose={selection.choose}
        />
      ) : null}
    </>
  );
}
