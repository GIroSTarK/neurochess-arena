import type { ReactNode } from "react";

import type { Piece, PieceKind } from "../position/position";
import { cx } from "../ui/cx";

// Original, reusable Staunton silhouettes. The contrasting outline is part of
// each piece, so neither color disappears into a light or dark square. Fill and
// stroke are inherited from the root element; `currentColor` is the outline ink.
const silhouettes: Record<PieceKind, ReactNode> = {
  p: (
    <>
      <circle cx="32" cy="16" r="8" />
      <path d="M26 24h12l-2 7c0 7 3 12 9 16H19c6-4 9-9 9-16z" />
      <path d="M20 47h24l3 7H17zM16 55h32v4H16z" />
    </>
  ),
  r: (
    <>
      <path d="M16 9h7v7h6V9h6v7h6V9h7v16l-7 6v15l5 4v6H18v-6l5-4V31l-7-6z" />
      <path d="M17 25h30M23 31h18M23 46h18M16 56h32v4H16z" />
    </>
  ),
  n: (
    <>
      <path d="M18 48c4-9 11-11 19-17l-9-2-8 6-8-5 6-15 9-7 1-6 8 6c17 1 18 19 12 34l-3 6z" />
      <path d="m19 17 7 1M37 16c8 8 6 16 1 23M22 49h22l5 8H16zM15 57h35v3H15z" />
      <circle cx="28" cy="17" r="1.5" className="fill-current stroke-none" />
    </>
  ),
  b: (
    <>
      <circle cx="32" cy="7" r="3" />
      <path d="M32 10c-8 7-13 12-13 19 0 6 5 9 13 9s13-3 13-9c0-7-5-12-13-19z" />
      <path d="m34 17-8 12M26 38h12l-2 6 7 5H21l7-5zM20 49h24l5 8H15zM15 57h34v3H15z" />
    </>
  ),
  q: (
    <>
      <path d="m13 16 9 8 3-13 7 12 7-12 3 13 9-8-7 25H20z" />
      <circle cx="12" cy="13" r="3" />
      <circle cx="24" cy="8" r="3" />
      <circle cx="32" cy="6" r="3" />
      <circle cx="40" cy="8" r="3" />
      <circle cx="52" cy="13" r="3" />
      <path d="M20 36h24M22 41h20l-2 7 7 5v4H17v-4l7-5zM16 57h32v3H16z" />
    </>
  ),
  k: (
    <>
      <path d="M30 3h4v6h6v4h-6v7h-4v-7h-6V9h6z" />
      <path d="M32 23c-7-12-19-7-16 4l7 14h18l7-14c3-11-9-16-16-4z" />
      <path d="M32 22v15M22 41h20l-2 7 7 5v4H17v-4l7-5zM16 57h32v3H16z" />
    </>
  ),
};

const inks = {
  white: "fill-board-ink-light text-board-ink-dark",
  black: "fill-board-ink-dark text-board-ink-light",
} as const;

export interface PieceIconProps extends Piece {
  /** Sizing utilities; defaults to 76% of the containing square. */
  readonly className?: string;
}

export function PieceIcon({ color, kind, className = "size-[76%]" }: PieceIconProps) {
  return (
    <svg
      className={cx("pointer-events-none block shrink-0 stroke-current", inks[color], className)}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      data-piece={color + "-" + kind}
    >
      <g strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {silhouettes[kind]}
      </g>
    </svg>
  );
}
