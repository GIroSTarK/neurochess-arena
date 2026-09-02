export const CHESS_COLORS = Object.freeze(["white", "black"] as const);
export const GAME_STATES = Object.freeze([
  "configuring",
  "active",
  "paused",
  "completed",
  "aborted",
] as const);
export const GAME_RESULTS = Object.freeze(["*", "1-0", "0-1", "1/2-1/2"] as const);
export const DRAW_REASONS = Object.freeze([
  "stalemate",
  "insufficient_material",
  "threefold_repetition",
  "fifty_move_rule",
] as const);
export const WIN_REASONS = Object.freeze([
  "checkmate",
  "human_resignation",
  "model_technical_loss",
] as const);
export const TERMINATION_REASONS = Object.freeze([
  ...WIN_REASONS,
  ...DRAW_REASONS,
  "aborted",
] as const);

export type ChessColor = (typeof CHESS_COLORS)[number];
export type GameState = (typeof GAME_STATES)[number];
export type GameResult = (typeof GAME_RESULTS)[number];
export type DrawReason = (typeof DRAW_REASONS)[number];
export type WinReason = (typeof WIN_REASONS)[number];
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export type CompletedOutcome =
  | { readonly result: "1-0" | "0-1"; readonly terminationReason: WinReason }
  | { readonly result: "1/2-1/2"; readonly terminationReason: DrawReason };

export type GameLifecycle =
  | {
      readonly state: "configuring" | "active" | "paused";
      readonly result: "*";
      readonly terminationReason: null;
    }
  | {
      readonly state: "aborted";
      readonly result: "*";
      readonly terminationReason: "aborted";
    }
  | ({ readonly state: "completed" } & CompletedOutcome);

export interface MoveRecord {
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly fen: string;
}

export type ChessSnapshot = GameLifecycle & {
  readonly fen: string;
  readonly pgn: string;
  readonly turn: ChessColor;
  readonly inCheck: boolean;
  readonly legalMoves: readonly string[];
  readonly moves: readonly MoveRecord[];
};

export const DOMAIN_ERROR_CODES = Object.freeze([
  "INVALID_UCI",
  "ILLEGAL_MOVE",
  "INVALID_GAME_STATE",
  "INVALID_COLOR",
  "INVALID_HISTORY",
  "INVALID_LIFECYCLE",
] as const);

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  readonly code: DomainErrorCode;
  /** One-based index of a rejected history entry, never the raw input. */
  readonly ply?: number;
}

export type DomainResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };

export interface RestoreGameInput {
  /** Complete, ordered UCI history, beginning at the standard initial position. */
  readonly moves: readonly string[];
  readonly lifecycle: GameLifecycle;
}

export interface ChessGame {
  snapshot(): ChessSnapshot;
  start(): DomainResult<ChessSnapshot>;
  playMove(uci: string): DomainResult<ChessSnapshot>;
  pause(): DomainResult<ChessSnapshot>;
  resume(): DomainResult<ChessSnapshot>;
  abort(): DomainResult<ChessSnapshot>;
  /** Trusted hook: the caller must establish that the resigning seat is human. */
  resignHuman(losingColor: ChessColor): DomainResult<ChessSnapshot>;
  /** Trusted hook: the caller must establish the model-invalid retry threshold. */
  recordTechnicalLoss(losingColor: ChessColor): DomainResult<ChessSnapshot>;
}
