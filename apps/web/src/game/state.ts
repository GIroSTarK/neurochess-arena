import type {
  GameErrorCode,
  GameReplayResponse,
  GameSnapshot,
  LifecycleCommand,
  MoveCommand,
} from "@neurochess/contracts";

export type PendingCommand = MoveCommand | LifecycleCommand;
export type LifecycleAction =
  { action: "pause" | "resume" | "abort" } | { action: "resign"; losingColor: "white" | "black" };

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
