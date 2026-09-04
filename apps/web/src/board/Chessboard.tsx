import type { ChessColor, GameSnapshot } from "@neurochess/contracts";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../ui/cx";

import { PieceIcon } from "./PieceIcon";
import { PromotionDialog } from "./PromotionDialog";
import { FILES, parsePosition, visualRows, type PromotionKind, type Square } from "./position";

export interface BoardView {
  readonly fen: string;
  readonly turn: ChessColor;
  readonly inCheck: boolean;
  readonly lastMove: string | undefined;
}

interface ChessboardProps {
  readonly snapshot: GameSnapshot;
  readonly orientation: ChessColor;
  readonly canMove: boolean;
  readonly interactionRevision: number;
  readonly onMove: (move: string) => void;
  readonly toolbar?: ReactNode;
  readonly view?: BoardView | undefined;
}

interface Selection {
  readonly epoch: string;
  readonly source: Square;
  readonly promotion: { destination: Square; moves: readonly string[] } | null;
}

const promotionOrder: readonly PromotionKind[] = ["q", "r", "b", "n"];

// Keyboard focus uses a dual light/dark keyline plus an inner dashed frame so it
// stays distinct from selection on both square colors.
const squareClassName = cx(
  "relative grid size-full place-items-center rounded-none border-0 p-0",
  "focus-visible:z-2 focus-visible:shadow-[inset_0_0_0_3px_var(--color-board-ink-light),inset_0_0_0_5px_var(--color-board-ink-dark)] focus-visible:outline-none",
  "focus-visible:before:pointer-events-none focus-visible:before:absolute focus-visible:before:inset-0.5 focus-visible:before:border focus-visible:before:border-dashed focus-visible:before:border-board-ink-dark focus-visible:before:content-['']",
);

const squareColors = {
  light: "bg-board-light text-board-ink-dark",
  dark: "bg-board-dark text-board-ink-light",
} as const;

const coordinateClassName =
  "pointer-events-none absolute font-mono text-[clamp(0.5625rem,1vw,0.75rem)] leading-none font-medium";

const targetClassName = {
  move: "pointer-events-none absolute aspect-square w-[24%] rounded-full border-2 border-board-ink-light bg-board-ink-dark",
  capture:
    "pointer-events-none absolute inset-[9%] rounded-full border-[3px] border-board-ink-dark shadow-[0_0_0_2px_var(--color-board-ink-light)]",
} as const;

export function Chessboard({
  snapshot,
  orientation,
  canMove,
  interactionRevision,
  onMove,
  toolbar,
  view,
}: ChessboardProps) {
  const { t } = useTranslation();
  const helpId = useId();
  const fen = view?.fen ?? snapshot.fen;
  const position = useMemo(() => parsePosition(fen), [fen]);
  const rows = useMemo(() => visualRows(orientation), [orientation]);
  const buttons = useRef(new Map<Square, HTMLButtonElement>());
  const [focusedSquare, setFocusedSquare] = useState<Square>("e2");
  const [selection, setSelection] = useState<Selection | null>(null);
  const epoch = snapshot.gameId + ":" + snapshot.version + ":" + interactionRevision;
  const selected = selection?.epoch === epoch ? selection : null;
  const enabled = !view && canMove && snapshot.state === "active" && position !== null;
  const sources = new Set(snapshot.legalMoves.map((move) => move.slice(0, 2)));
  const selectedMoves = selected
    ? snapshot.legalMoves.filter((move) => move.startsWith(selected.source))
    : [];
  const targets = new Set(selectedMoves.map((move) => move.slice(2, 4)));
  const lastMove = view ? view.lastMove : snapshot.moves.at(-1)?.uci;
  const promotion = selected?.promotion;

  function focus(square: Square) {
    setFocusedSquare(square);
    buttons.current.get(square)?.focus();
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

  if (!position) return <p>{t("board.invalidPosition")}</p>;

  return (
    <>
      <div
        className="flex aspect-square w-full touch-manipulation flex-col outline-1 outline-control-border"
        role="grid"
        aria-label={t("board.label")}
        aria-describedby={helpId}
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
                (view?.inCheck ?? snapshot.inCheck) &&
                piece?.kind === "k" &&
                piece.color === (view?.turn ?? snapshot.turn);
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
                  className="relative min-h-0 min-w-0"
                  key={square}
                  aria-colindex={columnIndex + 1}
                  aria-selected={isSelected}
                >
                  <button
                    type="button"
                    className={cx(squareClassName, squareColors[dark ? "dark" : "light"])}
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
                      <span
                        className={cx(coordinateClassName, "top-[3px] left-[3px]")}
                        aria-hidden="true"
                      >
                        {square[1]}
                      </span>
                    ) : null}
                    {rowIndex === 7 ? (
                      <span
                        className={cx(coordinateClassName, "right-[3px] bottom-[3px]")}
                        aria-hidden="true"
                      >
                        {square[0]}
                      </span>
                    ) : null}
                    {isLastMove ? (
                      <span
                        className="pointer-events-none absolute inset-[5%] corner-marks"
                        aria-hidden="true"
                      />
                    ) : null}
                    {piece ? <PieceIcon {...piece} /> : null}
                    {target ? (
                      <span
                        className={targetClassName[capture ? "capture" : "move"]}
                        aria-hidden="true"
                      />
                    ) : null}
                    {inCheck ? (
                      <span
                        className="absolute top-[4%] right-[4%] grid aspect-square w-[27%] place-items-center rounded-full border border-board-ink-dark bg-danger font-ui text-[clamp(0.625rem,1.4vw,1.125rem)] leading-none font-bold text-board-ink-dark shadow-[0_0_0_1px_var(--color-board-ink-light)]"
                        aria-hidden="true"
                      >
                        !
                      </span>
                    ) : null}
                    {isSelected ? (
                      <span
                        className="pointer-events-none absolute inset-[7%] border-2 border-board-ink-dark shadow-[0_0_0_2px_var(--color-board-ink-light)]"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {toolbar}
      <details className="order-4 mt-2 text-text-secondary">
        <summary className="min-h-target w-fit max-w-full cursor-pointer py-3 text-label">
          {t("board.keyboardHelp")}
        </summary>
        <p id={helpId} className="py-2">
          {t("board.instructions")}
        </p>
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
          }}
          onChoose={(move) => {
            if (selected) setSelection({ ...selected, promotion: null });
            onMove(move);
          }}
        />
      ) : null}
    </>
  );
}
