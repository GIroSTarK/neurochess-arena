import { Chess, type Move } from "chess.js";

import { failure, success } from "./result.js";
import type {
  ChessColor,
  CompletedOutcome,
  DomainResult,
  GameResult,
  MoveRecord,
} from "./types.js";

// Unlike $, this end-of-input assertion also rejects a final newline.
const uciPattern = /^[a-h][1-8][a-h][1-8][qrbn]?(?![\s\S])/;

export function isCanonicalUci(value: unknown): value is string {
  return (
    typeof value === "string" && uciPattern.test(value) && value.slice(0, 2) !== value.slice(2, 4)
  );
}

function toUci(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

/** Internal adapter; neither this class nor its FEN constructor is a package export. */
export class ChessRules {
  readonly #engine: Chess;
  readonly #positionCounts = new Map<string, number>();

  constructor(fen?: string) {
    this.#engine = new Chess(fen);
    this.#recordPosition();
  }

  fen(): string {
    return this.#engine.fen();
  }

  pgn(result: GameResult): string {
    this.#engine.setHeader("Result", result);
    return this.#engine.pgn({ newline: "\n" });
  }

  turn(): ChessColor {
    return this.#engine.turn() === "w" ? "white" : "black";
  }

  inCheck(): boolean {
    return this.#engine.isCheck();
  }

  legalMoves(): string[] {
    return this.#engine.moves({ verbose: true }).map(toUci).sort();
  }

  playMove(uci: string, ply: number): DomainResult<MoveRecord> {
    if (!isCanonicalUci(uci)) {
      return failure("INVALID_UCI");
    }

    // The engine's permissive parser accepts SAN, null moves, and surplus
    // promotion suffixes. Only an exact member of our UCI legal set may enter it.
    const candidate = this.#engine.moves({ verbose: true }).find((move) => toUci(move) === uci);
    if (candidate === undefined) {
      return failure("ILLEGAL_MOVE");
    }
    const accepted = this.#engine.move({
      from: candidate.from,
      to: candidate.to,
      ...(candidate.promotion === undefined ? {} : { promotion: candidate.promotion }),
    });
    this.#recordPosition();
    return success({ ply, uci, san: accepted.san, fen: this.fen() });
  }

  outcome(): CompletedOutcome | null {
    // Product policy, not chess.js's generic isDraw()/isGameOver() precedence.
    if (this.#engine.isCheckmate()) {
      return {
        result: this.turn() === "white" ? "0-1" : "1-0",
        terminationReason: "checkmate",
      };
    }
    if (this.#engine.isStalemate()) {
      return { result: "1/2-1/2", terminationReason: "stalemate" };
    }
    if (this.#engine.isInsufficientMaterial()) {
      return { result: "1/2-1/2", terminationReason: "insufficient_material" };
    }
    if ((this.#positionCounts.get(this.#positionKey()) ?? 0) >= 3) {
      return { result: "1/2-1/2", terminationReason: "threefold_repetition" };
    }
    if (this.#engine.isDrawByFiftyMoves()) {
      return { result: "1/2-1/2", terminationReason: "fifty_move_rule" };
    }
    return null;
  }

  #positionKey(): string {
    // fen() includes en passant only when a legal capture exists. In 1.4.0,
    // the built-in repetition hash incorrectly retains it for a pinned pawn.
    // Side, placement, castling and legal EP matter; move counters do not.
    return this.fen().split(" ").slice(0, 4).join(" ");
  }

  #recordPosition(): void {
    const key = this.#positionKey();
    this.#positionCounts.set(key, (this.#positionCounts.get(key) ?? 0) + 1);
  }
}
