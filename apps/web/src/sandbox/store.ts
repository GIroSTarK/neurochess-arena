import {
  emptyExport,
  emptyReplay,
  type ExportState,
  type ReplayState,
} from "../gameplay/archive-state";
import { isTerminal } from "../gameplay/snapshot";

import {
  type Announcement,
  initialSandboxState,
  type Readiness,
  type SandboxFlow,
  type SandboxNotice,
  type SandboxState,
} from "./state";

interface ViewFeedback {
  readonly announcement?: Announcement | null;
  readonly invalidateInteraction?: boolean;
}

interface TransitionFeedback extends ViewFeedback {
  readonly notice: SandboxNotice | null;
}

/** Complete typed substates are published atomically for `useSyncExternalStore`. */
export class SandboxStore {
  private state: SandboxState = initialSandboxState;
  private readonly listeners = new Set<() => void>();

  readonly get = (): SandboxState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  transition(flow: SandboxFlow, feedback: TransitionFeedback): void {
    const previous = this.state.snapshot;
    const changed =
      flow.snapshot === null ||
      previous?.gameId !== flow.snapshot.gameId ||
      previous.version !== flow.snapshot.version;
    const archive = changed ? { ...emptyReplay, ...emptyExport } : {};
    this.replace({
      ...this.state,
      ...archive,
      ...copyFlow(flow),
      notice: feedback.notice,
      ...this.feedback(feedback, flow.snapshot === null),
    });
  }

  setReadiness(readiness: Readiness, announce = false): void {
    this.replace({
      ...this.state,
      readiness,
      announcement:
        announce && readiness !== "checking"
          ? { kind: "connection", readiness }
          : this.state.announcement,
    });
  }

  setReplay(replay: ReplayState, feedback: ViewFeedback = {}): void {
    if (!this.state.snapshot || !isTerminal(this.state.snapshot)) return;
    this.replace({ ...this.state, ...copyReplay(replay), ...this.feedback(feedback) });
  }

  setExport(exportState: ExportState, feedback: ViewFeedback = {}): void {
    if (!this.state.snapshot || !isTerminal(this.state.snapshot)) return;
    this.replace({ ...this.state, ...copyExport(exportState), ...this.feedback(feedback) });
  }

  private feedback(feedback: ViewFeedback, clearAnnouncement = false) {
    return {
      announcement:
        feedback.announcement === undefined
          ? clearAnnouncement
            ? null
            : this.state.announcement
          : feedback.announcement,
      interactionRevision:
        this.state.interactionRevision + (feedback.invalidateInteraction ? 1 : 0),
    };
  }

  private replace(state: SandboxState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

// Structural typing allows callers to pass a whole snapshot. Copy only the selected slice so
// an older, wider object cannot replace another operation's state or feedback.
function copyFlow(flow: SandboxFlow): SandboxFlow {
  if (flow.snapshot === null) {
    return { phase: flow.phase, snapshot: null, pendingCommand: null };
  }
  if (flow.pendingCommand !== null) {
    return { phase: flow.phase, snapshot: flow.snapshot, pendingCommand: flow.pendingCommand };
  }
  return { phase: flow.phase, snapshot: flow.snapshot, pendingCommand: null };
}

function copyReplay(state: ReplayState): ReplayState {
  const position = state.replay
    ? { replay: state.replay, replayPly: state.replayPly }
    : { replay: null, replayPly: 0 as const };
  const status =
    state.replayPhase === "error"
      ? { replayPhase: state.replayPhase, replayNotice: state.replayNotice }
      : { replayPhase: state.replayPhase, replayNotice: null };
  return { ...position, ...status };
}

function copyExport(state: ExportState): ExportState {
  if (state.exportPhase === "manual") {
    return { exportPhase: state.exportPhase, exportText: state.exportText, exportNotice: null };
  }
  if (state.exportPhase === "error") {
    return { exportPhase: state.exportPhase, exportText: null, exportNotice: state.exportNotice };
  }
  return { exportPhase: state.exportPhase, exportText: null, exportNotice: null };
}
