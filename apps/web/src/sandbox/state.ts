import type {
  ChessColor,
  GameErrorCode,
  GameSnapshot,
  LifecycleCommand,
  MoveCommand,
} from "@neurochess/contracts";

import {
  emptyExport,
  emptyReplay,
  type ExportState,
  type ReplayState,
} from "../gameplay/archive-state";

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
  | "rate_limited"
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

interface SandboxFeedback {
  readonly readiness: Readiness;
  readonly notice: SandboxNotice | null;
  readonly announcement: Announcement | null;
  /** Invalidates selection/promotion without remounting or focusing the board. */
  readonly interactionRevision: number;
}

export type SandboxState = SandboxFeedback & SandboxFlow & ReplayState & ExportState;

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
