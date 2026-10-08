import { ApiFailure } from "../api/failures";
import {
  type ArchiveState,
  emptyExport,
  emptyReplay,
  type ExportState,
  type ReplayState,
} from "../gameplay/archive-state";
import { isTerminal } from "../gameplay/snapshot";

import {
  emptyInvocations,
  emptySeatKeys,
  humanColor,
  idleActivity,
  type InvocationState,
  type MatchActivity,
  type MatchFlow,
  type MatchState,
  type SeatKeysState,
} from "./state";

export class MatchStore {
  private flow: MatchFlow = {
    phase: "loading",
    details: null,
    activity: idleActivity,
    speed: 1500,
    issue: null,
    startedGameId: null,
  };
  private seats = emptySeatKeys;
  private archive: ArchiveState = { ...emptyReplay, ...emptyExport };
  private invocations = emptyInvocations;
  private state = this.project();
  private readonly listeners = new Set<() => void>();

  readonly get = (): MatchState => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getFlow() {
    return this.flow;
  }
  getActivity() {
    return this.flow.activity;
  }
  getSeats() {
    return this.seats;
  }
  getInvocations() {
    return this.invocations;
  }
  getArchive() {
    return { ...this.archive, snapshot: this.flow.details?.snapshot ?? null };
  }
  snapshot() {
    const snapshot = this.flow.details?.snapshot;
    if (!snapshot) throw new ApiFailure("malformed");
    return snapshot;
  }

  setFlow(flow: MatchFlow) {
    const previous = this.flow.details?.snapshot;
    const snapshot = flow.details?.snapshot;
    if (
      !snapshot ||
      snapshot.gameId !== previous?.gameId ||
      snapshot.version !== previous.version
    ) {
      this.archive = { ...emptyReplay, ...emptyExport };
    }
    if (!snapshot || snapshot.gameId !== previous?.gameId) this.invocations = emptyInvocations;
    // Copy only this slice: a structurally wider caller must not replace another lane's state.
    this.flow =
      flow.details === null
        ? {
            phase: flow.phase,
            details: null,
            activity: idleActivity,
            speed: flow.speed,
            issue: flow.issue,
            startedGameId: null,
          }
        : {
            phase: flow.phase,
            details: flow.details,
            activity: flow.activity,
            speed: flow.speed,
            issue: flow.issue,
            startedGameId: flow.startedGameId,
          };
    this.publish();
  }
  setActivity(activity: MatchActivity) {
    if (this.flow.details === null) return;
    const { lease, running, busy, turn, control, humanCommand } = activity;
    this.setFlow({ ...this.flow, activity: { lease, running, busy, turn, control, humanCommand } });
  }
  setSeats({ white, black, epoch }: SeatKeysState) {
    this.seats = { white, black, epoch };
    this.publish();
  }
  setInvocations({ phase, records, moveCount }: InvocationState) {
    this.invocations = records
      ? { phase, records, moveCount }
      : { phase, records: null, moveCount: 0 };
    this.publish();
  }
  setReplay(replay: ReplayState) {
    if (!this.flow.details || !isTerminal(this.flow.details.snapshot)) return;
    const { replay: position, replayPly, replayPhase, replayNotice } = replay;
    this.archive = {
      ...this.archive,
      ...(position ? { replay: position, replayPly } : { replay: null, replayPly: 0 as const }),
      ...(replayPhase === "error"
        ? { replayPhase, replayNotice }
        : { replayPhase, replayNotice: null }),
    };
    this.publish();
  }
  setExport(state: ExportState) {
    if (!this.flow.details || !isTerminal(this.flow.details.snapshot)) return;
    this.archive = {
      ...this.archive,
      ...(state.exportPhase === "manual"
        ? { exportPhase: state.exportPhase, exportText: state.exportText, exportNotice: null }
        : state.exportPhase === "error"
          ? { exportPhase: state.exportPhase, exportText: null, exportNotice: state.exportNotice }
          : { exportPhase: state.exportPhase, exportText: null, exportNotice: null }),
    };
    this.publish();
  }
  reset() {
    this.seats = { ...emptySeatKeys, epoch: this.seats.epoch + 1 };
    this.setFlow({
      phase: "loading",
      details: null,
      activity: idleActivity,
      speed: this.flow.speed,
      issue: null,
      startedGameId: null,
    });
  }

  private project(): MatchState {
    const { phase, details, activity, speed, issue, startedGameId } = this.flow;
    const { lease, running, busy, turn, control, humanCommand } = activity;
    const { white, black, epoch } = this.seats;
    const archive = this.archive;
    return {
      phase,
      details,
      busy,
      speed,
      issue,
      startedGameId,
      thinking: turn.phase === "thinking",
      canMove:
        phase === "ready" &&
        lease &&
        running &&
        !busy &&
        turn.phase === "idle" &&
        !control &&
        !humanCommand &&
        details.snapshot.state === "active" &&
        details.snapshot.turn === humanColor(details),
      pendingMove: humanCommand !== null,
      pendingControl: control !== null,
      keys: {
        white: white.source === "saved" || white.ready,
        black: black.source === "saved" || black.ready,
      },
      selections: {
        white: white.source === "saved" ? white.credentialId : "session",
        black: black.source === "saved" ? black.credentialId : "session",
      },
      keyEpoch: epoch,
      replay: archive.replay,
      replayPly: archive.replayPly,
      replayLoading: archive.replayPhase === "loading",
      replayError: archive.replayPhase === "error",
      exportBusy: archive.exportPhase === "loading",
      exportResult:
        archive.exportPhase === "idle" || archive.exportPhase === "loading"
          ? null
          : archive.exportPhase,
      exportText: archive.exportText,
      invocations: this.invocations.records,
      invocationsMoveCount: this.invocations.moveCount,
      invocationsLoading: this.invocations.phase === "loading",
      invocationsError: this.invocations.phase === "error",
    };
  }
  private publish() {
    this.state = this.project();
    this.listeners.forEach((listener) => listener());
  }
}
