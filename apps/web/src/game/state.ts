import type {
  ChessColor,
  GameErrorCode,
  GameReplayResponse,
  GameSnapshot,
  LifecycleCommand,
  MoveCommand,
  MoveRecord,
} from "@neurochess/contracts";

export type PendingCommand = MoveCommand | LifecycleCommand;
export type LifecycleAction =
  { action: "pause" | "resume" | "abort" } | { action: "resign"; losingColor: ChessColor };

export type SandboxNotice =
  | GameErrorCode
  | "existing"
  | "sandbox-unavailable"
  | "network"
  | "timeout"
  | "malformed"
  | "uncertain"
  | "sync-required"
  | "synchronized"
  | "recovered"
  | "recovery-required"
  | "pgn-copied"
  | "pgn-downloaded"
  | "pgn-manual";

export type SandboxPhase =
  | "entry"
  | "starting"
  | "ready"
  | "submitting"
  | "synchronizing"
  | "uncertain"
  | "sync-required"
  | "unavailable"
  | "access-error"
  | "recovering"
  | "recovery-required";

export type Readiness = "checking" | "ready" | "unavailable";

/** How an accepted snapshot arrived; drives the polite announcement. */
export type AcceptedKind = "started" | "existing" | "move" | "synchronized" | "lifecycle";

export type Announcement =
  | { readonly kind: AcceptedKind; readonly snapshot: GameSnapshot }
  | { readonly kind: "rejected"; readonly snapshot: GameSnapshot; readonly reason: SandboxNotice }
  | { readonly kind: "notice"; readonly notice: SandboxNotice }
  | { readonly kind: "connection"; readonly readiness: "ready" | "unavailable" }
  | { readonly kind: "replay"; readonly ply: number; readonly san: string | null };

export interface SandboxState {
  readonly readiness: Readiness;
  readonly phase: SandboxPhase;
  readonly snapshot: GameSnapshot | null;
  readonly pendingCommand: PendingCommand | null;
  readonly replay: GameReplayResponse | null;
  readonly replayPly: number;
  readonly replayPhase: "idle" | "loading" | "error";
  readonly exportPhase: "idle" | "loading" | "copied" | "downloaded" | "manual" | "error";
  readonly exportText: string | null;
  readonly archiveNotice: SandboxNotice | null;
  readonly notice: SandboxNotice | null;
  readonly announcement: Announcement | null;
  /** Invalidates selection/promotion without remounting or focusing the board. */
  readonly interactionRevision: number;
}

export const initialSandboxState: SandboxState = {
  readiness: "checking",
  phase: "entry",
  snapshot: null,
  pendingCommand: null,
  replay: null,
  replayPly: 0,
  replayPhase: "idle",
  exportPhase: "idle",
  exportText: null,
  archiveNotice: null,
  notice: null,
  announcement: null,
  interactionRevision: 0,
};

export function isTerminal(snapshot: GameSnapshot): boolean {
  return snapshot.state === "completed" || snapshot.state === "aborted";
}

export function isUnfinished(snapshot: GameSnapshot): boolean {
  return snapshot.state === "active" || snapshot.state === "paused";
}

/**
 * Identifies the accepted position together with the client-side invalidation counter.
 * Presentation state such as a board selection or an open confirmation is discarded when it
 * changes.
 */
export function interactionEpoch({
  snapshot,
  interactionRevision,
}: Pick<SandboxState, "snapshot" | "interactionRevision">): string {
  return (snapshot ? snapshot.gameId + ":" + snapshot.version : "none") + ":" + interactionRevision;
}

type Equality<T> = (a: T, b: T) => boolean;

/** Element-wise equality; the lists compared here never hold undefined. */
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
