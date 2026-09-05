import type { KeyboardEvent, Ref } from "react";

import type { SquareState } from "../position/squares";
import { cx } from "../ui/cx";

import { PieceIcon } from "./PieceIcon";

interface BoardSquareProps {
  readonly state: SquareState;
  readonly label: string;
  /** One-based column within the visible row. */
  readonly column: number;
  /** Whether this square holds the board's single tab stop. */
  readonly focusable: boolean;
  readonly showRank: boolean;
  readonly showFile: boolean;
  readonly ref: Ref<HTMLButtonElement>;
  readonly onFocus: () => void;
  readonly onActivate: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

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

export function BoardSquare({
  state,
  label,
  column,
  focusable,
  showRank,
  showFile,
  ref,
  onFocus,
  onActivate,
  onKeyDown,
}: BoardSquareProps) {
  const { square, piece, target } = state;
  return (
    <div
      role="gridcell"
      className="relative min-h-0 min-w-0"
      aria-colindex={column}
      aria-selected={state.selected}
    >
      <button
        type="button"
        className={cx(squareClassName, state.dark ? squareColors.dark : squareColors.light)}
        ref={ref}
        data-square={square}
        data-selected={state.selected || undefined}
        data-check={state.kingInCheck || undefined}
        data-last-move={state.lastMove || undefined}
        data-target={target === null ? undefined : target === "move" ? "move" : "capture"}
        aria-label={label}
        tabIndex={focusable ? 0 : -1}
        onFocus={onFocus}
        onClick={onActivate}
        onKeyDown={onKeyDown}
      >
        {showRank ? (
          <span className={cx(coordinateClassName, "top-[3px] left-[3px]")} aria-hidden="true">
            {square[1]}
          </span>
        ) : null}
        {showFile ? (
          <span className={cx(coordinateClassName, "right-[3px] bottom-[3px]")} aria-hidden="true">
            {square[0]}
          </span>
        ) : null}
        {state.lastMove ? (
          <span
            className="pointer-events-none absolute inset-[5%] corner-marks"
            aria-hidden="true"
          />
        ) : null}
        {piece ? <PieceIcon {...piece} /> : null}
        {target ? (
          <span
            className={target === "move" ? targetClassName.move : targetClassName.capture}
            aria-hidden="true"
          />
        ) : null}
        {state.kingInCheck ? (
          <span
            className="absolute top-[4%] right-[4%] grid aspect-square w-[27%] place-items-center rounded-full border border-board-ink-dark bg-danger font-ui text-[clamp(0.625rem,1.4vw,1.125rem)] leading-none font-bold text-board-ink-dark shadow-[0_0_0_1px_var(--color-board-ink-light)]"
            aria-hidden="true"
          >
            !
          </span>
        ) : null}
        {state.selected ? (
          <span
            className="pointer-events-none absolute inset-[7%] border-2 border-board-ink-dark shadow-[0_0_0_2px_var(--color-board-ink-light)]"
            aria-hidden="true"
          />
        ) : null}
      </button>
    </div>
  );
}
