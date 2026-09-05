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

/** Replace the whole flow together: a phase cannot outlive its required snapshot or command. */
export type SandboxFlow =
  | {
      readonly phase: "entry" | "unavailable" | "access-error";
      readonly snapshot: null;
      readonly pendingCommand: null;
    }
  | {
      readonly phase: "starting" | "recovering" | "recovery-required";
      readonly snapshot: GameSnapshot | null;
      readonly pendingCommand: null;
    }
  | {
      readonly phase: "ready" | "synchronizing" | "sync-required";
      readonly snapshot: GameSnapshot;
      readonly pendingCommand: null;
    }
  | {
      readonly phase: "submitting" | "uncertain" | "recovering" | "synchronizing";
      readonly snapshot: GameSnapshot;
      readonly pendingCommand: PendingCommand;
    };

export type SandboxPhase = SandboxFlow["phase"];

export type Readiness = "checking" | "ready" | "unavailable";

/** How an accepted snapshot arrived; drives the polite announcement. */
export type AcceptedKind = "started" | "existing" | "move" | "synchronized" | "lifecycle";

export type Announcement =
  | { readonly kind: AcceptedKind; readonly snapshot: GameSnapshot }
  | { readonly kind: "rejected"; readonly snapshot: GameSnapshot; readonly reason: SandboxNotice }
  | { readonly kind: "notice"; readonly notice: SandboxNotice }
  | { readonly kind: "connection"; readonly readiness: "ready" | "unavailable" }
  | { readonly kind: "replay"; readonly ply: number; readonly san: string | null };

/** Retrying a replay request can retain an already verified position and cursor. */
export type ReplayState = (
  | { readonly replay: null; readonly replayPly: 0 }
  | { readonly replay: GameReplayResponse; readonly replayPly: number }
) &
  (
    | { readonly replayPhase: "idle" | "loading"; readonly replayNotice: null }
    | { readonly replayPhase: "error"; readonly replayNotice: SandboxNotice }
  );

export type ExportState =
  | {
      readonly exportPhase: "idle" | "loading" | "copied" | "downloaded";
      readonly exportText: null;
      readonly exportNotice: null;
    }
  | {
      readonly exportPhase: "manual";
      readonly exportText: string;
      readonly exportNotice: null;
    }
  | {
      readonly exportPhase: "error";
      readonly exportText: null;
      readonly exportNotice: SandboxNotice;
    };

interface SandboxFeedback {
  readonly readiness: Readiness;
  readonly notice: SandboxNotice | null;
  readonly announcement: Announcement | null;
  /** Invalidates selection/promotion without remounting or focusing the board. */
  readonly interactionRevision: number;
}

export type SandboxState = SandboxFeedback & SandboxFlow & ReplayState & ExportState;

export const emptyReplay: ReplayState = {
  replay: null,
  replayPly: 0,
  replayPhase: "idle",
  replayNotice: null,
};

export const emptyExport: ExportState = {
  exportPhase: "idle",
  exportText: null,
  exportNotice: null,
};

export const initialSandboxState: SandboxState = {
  readiness: "checking",
  phase: "entry",
  snapshot: null,
  pendingCommand: null,
  ...emptyReplay,
  ...emptyExport,
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
 * Combines the accepted position with client-side invalidation. Changes discard board
 * selection and open confirmations.
 */
export function interactionEpoch({
  snapshot,
  interactionRevision,
}: Pick<SandboxState, "snapshot" | "interactionRevision">): string {
  return (snapshot ? snapshot.gameId + ":" + snapshot.version : "none") + ":" + interactionRevision;
}

type Equality<T> = (a: T, b: T) => boolean;

/** These lists never contain undefined. */
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
