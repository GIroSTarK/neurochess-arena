import type { ChessColor, GameSnapshot } from "@neurochess/contracts";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PieceIcon } from "./PieceIcon";
import { PromotionDialog } from "./PromotionDialog";
import {
  FILES,
  isSquare,
  parsePosition,
  visualRows,
  type PromotionKind,
  type Square,
} from "./position";

interface ChessboardProps {
  readonly snapshot: GameSnapshot;
  readonly orientation: ChessColor;
  readonly canMove: boolean;
  readonly interactionRevision: number;
  readonly onMove: (move: string) => void;
  readonly toolbar?: ReactNode;
}

interface Selection {
  readonly epoch: string;
  readonly source: Square;
  readonly promotion: { destination: Square; moves: readonly string[] } | null;
}

const promotionOrder: readonly PromotionKind[] = ["q", "r", "b", "n"];

export function Chessboard({
  snapshot,
  orientation,
  canMove,
  interactionRevision,
  onMove,
  toolbar,
}: ChessboardProps) {
  const { t } = useTranslation();
  const helpId = useId();
  const position = useMemo(() => parsePosition(snapshot.fen), [snapshot.fen]);
  const rows = useMemo(() => visualRows(orientation), [orientation]);
  const buttons = useRef(new Map<Square, HTMLButtonElement>());
  const [focusedSquare, setFocusedSquare] = useState<Square>("e2");
  const [selection, setSelection] = useState<Selection | null>(null);
  const epoch = snapshot.gameId + ":" + snapshot.version + ":" + interactionRevision;
  const selected = selection?.epoch === epoch ? selection : null;
  const enabled = canMove && snapshot.state === "active" && position !== null;
  const sources = new Set(snapshot.legalMoves.map((move) => move.slice(0, 2)));
  const selectedMoves = selected
    ? snapshot.legalMoves.filter((move) => move.startsWith(selected.source))
    : [];
  const targets = new Set(selectedMoves.map((move) => move.slice(2, 4)));
  const lastMove = snapshot.moves.at(-1)?.uci;
  const promotion = selected?.promotion;

  function focus(square: Square, options?: FocusOptions) {
    setFocusedSquare(square);
    buttons.current.get(square)?.focus(options);
  }

  function activate(square: Square) {
    focus(square);
    if (!enabled) return;
    const moves = selectedMoves.filter((move) => move.slice(2, 4) === square);
    if (selected && moves.length > 0) {
      if (moves.some((move) => move.length === 5)) {
        setSelection({ ...selected, promotion: { destination: square, moves } });
      } else if (moves[0]) {
        onMove(moves[0]);
      }
    } else if (sources.has(square)) {
      setSelection(selected?.source === square ? null : { epoch, source: square, promotion: null });
    } else {
      setSelection(null);
    }
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
        setSelection(null);
        return;
      default:
        return;
    }
    event.preventDefault();
    const nextSquare = rows[nextRow]?.[nextColumn];
    if (nextSquare) focus(nextSquare);
  }

  if (!position) return <p className="notice">{t("board.invalidPosition")}</p>;

  return (
    <>
      <div
        className="chessboard"
        role="grid"
        aria-label={t("board.label")}
        aria-describedby={helpId}
        aria-readonly={!enabled}
        aria-rowcount={8}
        aria-colcount={8}
        data-orientation={orientation}
      >
        {rows.map((row, rowIndex) => (
          <div
            className="chessboard__row"
            role="row"
            key={row[0]?.[1]}
            aria-rowindex={rowIndex + 1}
          >
            {row.map((square, columnIndex) => {
              const piece = position.pieces.get(square);
              const target = targets.has(square);
              const sourcePiece = selected ? position.pieces.get(selected.source) : undefined;
              const enPassant =
                target &&
                sourcePiece?.kind === "p" &&
                !piece &&
                square === position.enPassant &&
                selected?.source[0] !== square[0];
              const capture = target && (piece !== undefined || enPassant);
              const inCheck =
                snapshot.inCheck && piece?.kind === "k" && piece.color === snapshot.turn;
              const isSelected = selected?.source === square;
              const isLastMove =
                lastMove?.slice(0, 2) === square || lastMove?.slice(2, 4) === square;
              const fileIndex = FILES.indexOf(square[0] as (typeof FILES)[number]);
              const dark = (fileIndex + Number(square[1])) % 2 === 1;
              const label = [
                piece
                  ? t("board.occupied", { square, piece: t(`pieces.${piece.color}.${piece.kind}`) })
                  : t("board.empty", { square }),
                isSelected ? t("board.selected") : "",
                target
                  ? t(
                      enPassant
                        ? "board.enPassantTarget"
                        : capture
                          ? "board.captureTarget"
                          : "board.legalTarget",
                    )
                  : "",
                isLastMove ? t("board.lastMove") : "",
                inCheck ? t("board.inCheck") : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div
                  role="gridcell"
                  className="chessboard__cell"
                  key={square}
                  aria-colindex={columnIndex + 1}
                  aria-selected={isSelected}
                >
                  <button
                    type="button"
                    className={"square square--" + (dark ? "dark" : "light")}
                    ref={(element) => {
                      if (element) buttons.current.set(square, element);
                      else buttons.current.delete(square);
                    }}
                    data-square={square}
                    data-selected={isSelected || undefined}
                    data-check={inCheck || undefined}
                    data-last-move={isLastMove || undefined}
                    data-target={target ? (capture ? "capture" : "move") : undefined}
                    aria-label={label}
                    tabIndex={focusedSquare === square ? 0 : -1}
                    onFocus={() => setFocusedSquare(square)}
                    onClick={() => activate(square)}
                    onKeyDown={(event) => navigate(event, rowIndex, columnIndex)}
                  >
                    {columnIndex === 0 ? (
                      <span className="square__rank" aria-hidden="true">
                        {square[1]}
                      </span>
                    ) : null}
                    {rowIndex === 7 ? (
                      <span className="square__file" aria-hidden="true">
                        {square[0]}
                      </span>
                    ) : null}
                    {isLastMove ? <span className="square__last-move" aria-hidden="true" /> : null}
                    {piece ? <PieceIcon {...piece} /> : null}
                    {target ? (
                      <span
                        className={
                          "square__target square__target--" + (capture ? "capture" : "move")
                        }
                        aria-hidden="true"
                      />
                    ) : null}
                    {inCheck ? (
                      <span className="square__check" aria-hidden="true">
                        !
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {toolbar}
      <details className="keyboard-help">
        <summary>{t("board.keyboardHelp")}</summary>
        <p id={helpId}>{t("board.instructions")}</p>
      </details>
      {promotion && enabled ? (
        <PromotionDialog
          color={snapshot.turn}
          destination={promotion.destination}
          choices={promotionOrder.flatMap((kind) => {
            const move = promotion.moves.find((candidate) => candidate[4] === kind);
            return move ? [{ kind, move }] : [];
          })}
          onCancel={() => {
            if (selected) setSelection({ ...selected, promotion: null });
            focus(promotion.destination, { preventScroll: true });
          }}
          onChoose={(move) => {
            if (selected) setSelection({ ...selected, promotion: null });
            if (isSquare(move.slice(2, 4))) focus(promotion.destination, { preventScroll: true });
            onMove(move);
          }}
        />
      ) : null}
    </>
  );
}
