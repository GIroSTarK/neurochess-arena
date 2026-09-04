import type { ChessColor } from "@neurochess/contracts";

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
export type Square = `${(typeof FILES)[number]}${(typeof RANKS)[number]}`;
export type PieceKind = "p" | "r" | "n" | "b" | "q" | "k";
export type PromotionKind = "q" | "r" | "b" | "n";

export interface Piece {
  readonly color: ChessColor;
  readonly kind: PieceKind;
}

export interface Position {
  readonly pieces: ReadonlyMap<Square, Piece>;
  readonly turn: ChessColor;
  readonly enPassant: Square | null;
}

export function isSquare(value: string): value is Square {
  return /^[a-h][1-8]$/.test(value);
}

/**
 * A defensive display parser, not a rules engine. It neither generates moves
 * nor infers check, castling rights, or a result.
 */
export function parsePosition(fen: string): Position | null {
  if (fen.length > 128) return null;
  const fields = fen.split(" ");
  if (fields.length !== 6) return null;
  const [placement, side, castling, enPassant, halfmove, fullmove] = fields;
  if (
    !placement ||
    (side !== "w" && side !== "b") ||
    !castling ||
    !/^(?:-|K?Q?k?q?)$/.test(castling) ||
    !enPassant ||
    !/^(?:-|[a-h][36])$/.test(enPassant) ||
    !halfmove ||
    !/^\d+$/.test(halfmove) ||
    !Number.isSafeInteger(Number(halfmove)) ||
    !fullmove ||
    !/^[1-9]\d*$/.test(fullmove) ||
    !Number.isSafeInteger(Number(fullmove))
  ) {
    return null;
  }

  const ranks = placement.split("/");
  if (ranks.length !== 8) return null;
  const pieces = new Map<Square, Piece>();
  for (const [row, rank] of ranks.entries()) {
    let file = 0;
    for (const character of rank) {
      if (/^[1-8]$/.test(character)) {
        file += Number(character);
      } else if (/^[prnbqkPRNBQK]$/.test(character)) {
        const fileName = FILES[file];
        const rankName = RANKS[7 - row];
        if (!fileName || !rankName) return null;
        pieces.set(`${fileName}${rankName}`, {
          color: character === character.toUpperCase() ? "white" : "black",
          kind: character.toLowerCase() as PieceKind,
        });
        file += 1;
      } else return null;
      if (file > 8) return null;
    }
    if (file !== 8) return null;
  }
  return {
    pieces,
    turn: side === "w" ? "white" : "black",
    enPassant: isSquare(enPassant) ? enPassant : null,
  };
}

export function visualRows(orientation: ChessColor): Square[][] {
  const files = orientation === "white" ? FILES : FILES.toReversed();
  const ranks = orientation === "white" ? RANKS.toReversed() : RANKS;
  return ranks.map((rank) => files.map((file): Square => `${file}${rank}`));
}
