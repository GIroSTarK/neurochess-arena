import type {
  GameErrorCode,
  GameSnapshot,
  MoveCommand,
  LifecycleCommand,
  GameReplayResponse,
} from "@neurochess/contracts";

import { ApiFailure, type SandboxApi } from "../api";
import type { SandboxNavigation } from "./navigation";
import { browserPgnDelivery, type PgnDelivery } from "./pgn";

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

export type Announcement =
  | {
      readonly kind: "started" | "existing" | "move" | "synchronized" | "lifecycle";
      readonly snapshot: GameSnapshot;
    }
  | { readonly kind: "rejected"; readonly snapshot: GameSnapshot; readonly reason: SandboxNotice }
  | { readonly kind: "notice"; readonly notice: SandboxNotice }
  | { readonly kind: "connection"; readonly readiness: "ready" | "unavailable" }
  | { readonly kind: "replay"; readonly ply: number; readonly san: string | null };

export interface SandboxState {
  readonly readiness: "checking" | "ready" | "unavailable";
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

interface Operation {
  readonly generation: number;
  readonly abort: AbortController;
}

const accessCodes = new Set<GameErrorCode>(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"]);
const rejectionCodes = new Set<GameErrorCode>([
  "INVALID_REQUEST",
  "INVALID_UCI",
  "ILLEGAL_MOVE",
  "INVALID_GAME_STATE",
]);

export class SandboxController {
  private state: SandboxState = {
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
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private connected = true;
  private operation: Operation | null = null;
  private readinessAbort: AbortController | null = null;
  private replayAbort: AbortController | null = null;
  private exportAbort: AbortController | null = null;
  private recoveringGame = false;
  private unsubscribeNavigation: (() => void) | null = null;

  constructor(
    private readonly api: SandboxApi,
    private readonly commandId: () => string = () => crypto.randomUUID(),
    private readonly navigation?: SandboxNavigation,
    private readonly delivery: PgnDelivery = browserPgnDelivery,
  ) {}

  readonly getSnapshot = (): SandboxState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(): () => void {
    this.connected = true;
    void this.checkReadiness();
    this.unsubscribeNavigation?.();
    this.unsubscribeNavigation =
      this.navigation?.subscribe(() => {
        this.operation?.abort.abort();
        this.operation = null;
        this.generation += 1;
        this.clearArchive();
        this.update({ snapshot: null, pendingCommand: null, phase: "entry", notice: null });
        void this.recover();
      }) ?? null;
    if (!this.state.snapshot && !this.state.pendingCommand) void this.recover();
    else if (this.state.snapshot && isTerminal(this.state.snapshot) && !this.state.replay)
      void this.loadReplay();
    return () => this.disconnect();
  }

  disconnect(): void {
    this.connected = false;
    this.generation += 1;
    this.operation?.abort.abort();
    this.operation = null;
    this.readinessAbort?.abort();
    this.readinessAbort = null;
    this.unsubscribeNavigation?.();
    this.unsubscribeNavigation = null;
    this.replayAbort?.abort();
    this.replayAbort = null;
    this.exportAbort?.abort();
    this.exportAbort = null;
    if (this.state.pendingCommand) {
      this.update({ phase: "uncertain", notice: "uncertain" });
    } else if (this.state.phase === "synchronizing") {
      this.update({ phase: "sync-required", notice: "sync-required" });
    } else if (this.state.phase === "starting") {
      this.update({ phase: this.state.snapshot ? "ready" : "entry" });
    } else if (this.state.phase === "recovering") {
      this.update({ phase: "recovery-required", notice: "recovery-required" });
    }
  }

  async checkReadiness(): Promise<void> {
    if (!this.connected || this.readinessAbort) return;
    const abort = new AbortController();
    this.readinessAbort = abort;
    const isRetry = this.state.readiness === "unavailable";
    this.update({ readiness: "checking" });
    let readiness: "ready" | "unavailable" = "unavailable";
    try {
      readiness = (await this.api.ready(abort.signal)) ? "ready" : "unavailable";
    } catch {
      // Readiness does not decide sandbox availability or replace a guest.
    }
    if (!this.connected || abort.signal.aborted || this.readinessAbort !== abort) return;
    this.readinessAbort = null;
    this.update({
      readiness,
      ...(isRetry || readiness === "unavailable"
        ? { announcement: { kind: "connection", readiness } as const }
        : {}),
    });
  }

  async start(): Promise<void> {
    if (
      this.state.readiness !== "ready" ||
      this.state.snapshot?.state === "active" ||
      this.state.snapshot?.state === "paused" ||
      this.state.pendingCommand ||
      ["recovering", "recovery-required"].includes(this.state.phase)
    )
      return;
    const operation = this.begin();
    if (!operation) return;
    this.update({ phase: "starting", notice: null });
    try {
      // The cookie must exist before creation. No mount effect bootstraps guests.
      await this.api.bootstrap(operation.abort.signal);
      if (!this.current(operation)) return;
      const snapshot = await this.api.create(operation.abort.signal);
      if (this.current(operation)) {
        this.clearArchive();
        this.navigation?.open(snapshot.gameId);
        this.accept(snapshot, "started", null);
      }
    } catch (error: unknown) {
      if (!this.current(operation)) return;
      const failure = safeFailure(error);
      if (failure.code === "GAME_CONFLICT" && failure.currentSnapshot) {
        this.clearArchive();
        await this.pauseRecovered(operation, failure.currentSnapshot);
      } else {
        this.clearArchive();
        const notice =
          failure.code === "NOT_FOUND" ? "sandbox-unavailable" : failureNotice(failure);
        this.update({
          snapshot: null,
          pendingCommand: null,
          phase: failure.code === "NOT_FOUND" ? "unavailable" : "entry",
          notice,
          announcement: { kind: "notice", notice },
          interactionRevision: this.state.interactionRevision + 1,
        });
      }
    } finally {
      this.finish(operation);
    }
  }

  async submit(move: string): Promise<void> {
    const snapshot = this.state.snapshot;
    if (
      this.state.phase !== "ready" ||
      !snapshot ||
      snapshot.state !== "active" ||
      !snapshot.legalMoves.includes(move)
    )
      return;
    // Acquired synchronously, before generating a command or notifying React.
    const operation = this.begin();
    if (!operation) return;
    const command: MoveCommand = {
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: this.commandId(),
      move,
    };
    this.update({ pendingCommand: command });
    await this.sendCommand(operation, command);
  }

  async lifecycle(action: LifecycleAction): Promise<void> {
    const snapshot = this.state.snapshot;
    if (this.state.phase !== "ready" || !snapshot || isTerminal(snapshot)) return;
    const operation = this.begin();
    if (!operation) return;
    const command: LifecycleCommand = {
      ...action,
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: this.commandId(),
    };
    this.update({ pendingCommand: command });
    await this.sendCommand(operation, command);
  }

  async retryMove(): Promise<void> {
    const command = this.state.pendingCommand;
    if (this.state.phase !== "uncertain" || !command) return;
    const operation = this.begin();
    if (operation) await this.sendCommand(operation, command);
  }

  async synchronize(): Promise<void> {
    if (!["uncertain", "sync-required"].includes(this.state.phase) || !this.state.snapshot) return;
    const operation = this.begin();
    if (!operation) return;
    try {
      await this.readBack(operation);
    } finally {
      this.finish(operation);
    }
  }

  private async sendCommand(operation: Operation, command: PendingCommand): Promise<void> {
    this.update({ phase: "submitting", notice: null });
    try {
      const snapshot = await ("move" in command
        ? this.api.move(command, operation.abort.signal)
        : this.api.lifecycle(command, operation.abort.signal));
      if (!this.current(operation)) return;
      if (
        !this.validRevision(snapshot, command.gameId) ||
        snapshot.version <= command.expectedVersion ||
        !matchesCommand(snapshot, command)
      ) {
        throw new ApiFailure("malformed");
      }
      this.accept(snapshot, "move" in command ? "move" : "lifecycle", null);
    } catch (error: unknown) {
      if (!this.current(operation)) return;
      const failure = safeFailure(error);
      if (this.loseAccess(failure)) return;
      if (
        failure.code === "GAME_CONFLICT" &&
        failure.currentSnapshot &&
        this.validRevision(failure.currentSnapshot, command.gameId)
      ) {
        this.accept(failure.currentSnapshot, "synchronized", "GAME_CONFLICT");
        return;
      }
      const rejection = failure.code && rejectionCodes.has(failure.code) ? failure.code : undefined;
      if (rejection) this.update({ pendingCommand: null });
      // A failed response can follow a committed write. Never resend implicitly.
      await this.readBack(operation, rejection);
    } finally {
      this.finish(operation);
    }
  }

  private async readBack(operation: Operation, rejection?: SandboxNotice): Promise<void> {
    const accepted = this.state.snapshot;
    if (!accepted || !this.current(operation)) return;
    this.update({ phase: "synchronizing", notice: rejection ?? null });
    try {
      const snapshot = await this.api.snapshot(accepted.gameId, operation.abort.signal);
      if (!this.current(operation)) return;
      if (!this.validRevision(snapshot, accepted.gameId)) throw new ApiFailure("malformed");
      const pending = this.state.pendingCommand;
      if (pending && snapshot.version === pending.expectedVersion) {
        // An unchanged GET cannot prove a timed-out POST will not commit later.
        this.update({
          snapshot,
          phase: "uncertain",
          notice: "uncertain",
          announcement: { kind: "notice", notice: "uncertain" },
          interactionRevision: this.state.interactionRevision + 1,
        });
      } else {
        // A newer aggregate revision also prevents the old command committing.
        this.accept(
          snapshot,
          "synchronized",
          rejection ?? "synchronized",
          rejection ? { kind: "rejected", snapshot, reason: rejection } : undefined,
        );
      }
    } catch (error: unknown) {
      if (!this.current(operation)) return;
      if (this.loseAccess(safeFailure(error))) return;
      const pending = this.state.pendingCommand !== null;
      const notice = pending ? "uncertain" : "sync-required";
      this.update({
        phase: pending ? "uncertain" : "sync-required",
        notice,
        announcement: { kind: "notice", notice },
      });
    }
  }

  async recover(): Promise<void> {
    if (this.state.pendingCommand) return;
    const operation = this.begin();
    if (!operation) return;
    const gameId = this.navigation?.read() ?? this.state.snapshot?.gameId ?? null;
    this.recoveringGame = true;
    this.update({ phase: "recovering", notice: null });
    try {
      if (gameId === "invalid") throw new ApiFailure("api", "NOT_FOUND");
      const snapshot = gameId
        ? await this.api.snapshot(gameId, operation.abort.signal)
        : await this.api.unfinished(operation.abort.signal);
      if (!this.current(operation)) return;
      if (snapshot) {
        if (gameId && !this.validRevision(snapshot, gameId)) throw new ApiFailure("malformed");
        await this.pauseRecovered(operation, snapshot);
      } else {
        this.recoveringGame = false;
        this.update({ phase: "entry", snapshot: null });
      }
    } catch (error: unknown) {
      if (!this.current(operation)) return;
      const failure = safeFailure(error);
      if (!gameId && failure.code === "UNAUTHORIZED") {
        this.recoveringGame = false;
        this.update({ phase: "entry", snapshot: null, notice: null });
      } else if (!gameId && failure.code === "NOT_FOUND") {
        this.recoveringGame = false;
        this.update({ phase: "unavailable", notice: "sandbox-unavailable" });
      } else if (!this.loseAccess(failure)) {
        this.update({ phase: "recovery-required", notice: failureNotice(failure) });
      }
    } finally {
      this.finish(operation);
    }
  }

  private async pauseRecovered(operation: Operation, initial: GameSnapshot): Promise<void> {
    this.recoveringGame = true;
    this.navigation?.open(initial.gameId, true);
    let snapshot = initial;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!this.current(operation)) return;
      this.update({
        snapshot,
        pendingCommand: null,
        phase: "recovering",
        interactionRevision: this.state.interactionRevision + 1,
      });
      if (snapshot.state !== "active") {
        if (snapshot.state !== "paused" && !isTerminal(snapshot)) throw new ApiFailure("malformed");
        this.accept(snapshot, "existing", "existing");
        return;
      }
      const command: LifecycleCommand = {
        action: "pause",
        gameId: snapshot.gameId,
        expectedVersion: snapshot.version,
        commandId: this.commandId(),
      };
      this.update({ pendingCommand: command });
      try {
        const paused = await this.api.lifecycle(command, operation.abort.signal);
        if (!this.current(operation)) return;
        if (
          !this.validRevision(paused, snapshot.gameId) ||
          paused.version <= snapshot.version ||
          paused.state !== "paused"
        )
          throw new ApiFailure("malformed");
        this.accept(paused, "existing", "recovered");
        return;
      } catch (error: unknown) {
        if (!this.current(operation)) return;
        const failure = safeFailure(error);
        if (this.loseAccess(failure)) return;
        if (
          failure.code === "GAME_CONFLICT" &&
          failure.currentSnapshot &&
          this.validRevision(failure.currentSnapshot, snapshot.gameId)
        ) {
          snapshot = failure.currentSnapshot;
          this.update({ snapshot, pendingCommand: null });
          if (snapshot.state !== "active") {
            this.accept(snapshot, "existing", "recovered");
            return;
          }
          continue;
        }
        const rejection =
          failure.code && rejectionCodes.has(failure.code) ? failure.code : undefined;
        if (rejection) this.update({ pendingCommand: null });
        await this.readBack(operation, rejection);
        return;
      }
    }
    this.update({
      snapshot,
      pendingCommand: null,
      phase: "recovery-required",
      notice: "recovery-required",
    });
  }

  async loadReplay(): Promise<void> {
    const snapshot = this.state.snapshot;
    if (!this.connected || !snapshot || !isTerminal(snapshot) || this.replayAbort) return;
    const abort = new AbortController();
    this.replayAbort = abort;
    this.update({ replayPhase: "loading", archiveNotice: null });
    const current = () =>
      this.connected &&
      this.replayAbort === abort &&
      this.state.snapshot?.gameId === snapshot.gameId &&
      this.state.snapshot.version === snapshot.version;
    try {
      const replay = await this.api.replay(snapshot.gameId, abort.signal);
      if (!current()) return;
      if (JSON.stringify(replay.snapshot) !== JSON.stringify(snapshot))
        throw new ApiFailure("malformed");
      this.update({ replay, replayPly: snapshot.moves.length, replayPhase: "idle" });
    } catch (error: unknown) {
      if (!current()) return;
      const failure = safeFailure(error);
      if (!this.loseAccess(failure))
        this.update({ replayPhase: "error", archiveNotice: failureNotice(failure) });
    } finally {
      if (this.replayAbort === abort) this.replayAbort = null;
    }
  }

  selectPly(ply: number): void {
    const replay = this.state.replay;
    if (!replay || !Number.isInteger(ply) || ply < 0 || ply > replay.snapshot.moves.length) return;
    this.update({
      replayPly: ply,
      interactionRevision: this.state.interactionRevision + 1,
      announcement: { kind: "replay", ply, san: replay.snapshot.moves[ply - 1]?.san ?? null },
    });
  }

  async exportPgn(action: "copy" | "download"): Promise<void> {
    const snapshot = this.state.snapshot;
    if (!this.connected || !snapshot || !isTerminal(snapshot) || this.exportAbort) return;
    const abort = new AbortController();
    this.exportAbort = abort;
    this.update({ exportPhase: "loading", exportText: null, archiveNotice: null });
    const current = () =>
      this.connected &&
      this.exportAbort === abort &&
      this.state.snapshot?.gameId === snapshot.gameId &&
      this.state.snapshot.version === snapshot.version;
    try {
      const response = await this.api.pgn(snapshot.gameId, abort.signal);
      if (!current()) return;
      if (
        response.gameId !== snapshot.gameId ||
        response.version !== snapshot.version ||
        response.pgn !== snapshot.pgn
      )
        throw new ApiFailure("malformed");
      let outcome: "copied" | "downloaded" | "manual";
      if (action === "copy")
        outcome = (await this.delivery.copy(response.pgn)) ? "copied" : "manual";
      else {
        this.delivery.download(response.pgn, snapshot.gameId);
        outcome = "downloaded";
      }
      if (!current()) return;
      this.update({
        exportPhase: outcome,
        exportText: outcome === "manual" ? response.pgn : null,
        announcement: {
          kind: "notice",
          notice:
            outcome === "copied"
              ? "pgn-copied"
              : outcome === "manual"
                ? "pgn-manual"
                : "pgn-downloaded",
        },
      });
    } catch (error: unknown) {
      if (!current()) return;
      const failure = safeFailure(error);
      if (!this.loseAccess(failure))
        this.update({ exportPhase: "error", archiveNotice: failureNotice(failure) });
    } finally {
      if (this.exportAbort === abort) this.exportAbort = null;
    }
  }

  private clearArchive(): void {
    this.replayAbort?.abort();
    this.exportAbort?.abort();
    this.replayAbort = null;
    this.exportAbort = null;
    this.update({
      replay: null,
      replayPhase: "idle",
      replayPly: 0,
      exportPhase: "idle",
      exportText: null,
      archiveNotice: null,
    });
  }

  private validRevision(snapshot: GameSnapshot, gameId: string): boolean {
    return snapshot.gameId === gameId && snapshot.version >= (this.state.snapshot?.version ?? 0);
  }

  private loseAccess(failure: ApiFailure): boolean {
    if (!failure.code || !accessCodes.has(failure.code)) return false;
    this.update({
      snapshot: null,
      pendingCommand: null,
      phase: "access-error",
      notice: failure.code,
      announcement: { kind: "notice", notice: failure.code },
      interactionRevision: this.state.interactionRevision + 1,
    });
    this.clearArchive();
    this.recoveringGame = false;
    return true;
  }

  private accept(
    snapshot: GameSnapshot,
    kind: "started" | "existing" | "move" | "synchronized" | "lifecycle",
    notice: SandboxNotice | null,
    announcement?: Announcement,
  ): void {
    const needsPause = this.recoveringGame && snapshot.state === "active";
    if (!needsPause) this.recoveringGame = false;
    this.update({
      snapshot,
      pendingCommand: null,
      phase: needsPause ? "recovery-required" : "ready",
      notice: needsPause ? "recovery-required" : notice,
      announcement: announcement ?? { kind, snapshot },
      interactionRevision: this.state.interactionRevision + 1,
    });
    if (isTerminal(snapshot) && !this.state.replay) void this.loadReplay();
  }

  private begin(): Operation | null {
    if (!this.connected || this.operation) return null;
    const operation = { generation: ++this.generation, abort: new AbortController() };
    this.operation = operation;
    return operation;
  }

  private current(operation: Operation): boolean {
    return (
      this.connected && operation.generation === this.generation && !operation.abort.signal.aborted
    );
  }

  private finish(operation: Operation): void {
    if (this.current(operation)) this.operation = null;
  }

  private update(patch: Partial<SandboxState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

function safeFailure(error: unknown): ApiFailure {
  return error instanceof ApiFailure ? error : new ApiFailure("network");
}

export function isTerminal(snapshot: GameSnapshot): boolean {
  return snapshot.state === "completed" || snapshot.state === "aborted";
}

function matchesCommand(snapshot: GameSnapshot, command: PendingCommand): boolean {
  if ("move" in command) return true;
  if (command.action === "resign")
    return (
      snapshot.state === "completed" &&
      snapshot.terminationReason === "human_resignation" &&
      snapshot.result === (command.losingColor === "white" ? "0-1" : "1-0")
    );
  return snapshot.state === { pause: "paused", resume: "active", abort: "aborted" }[command.action];
}

function failureNotice(failure: ApiFailure): SandboxNotice {
  return (
    failure.code ??
    (failure.kind === "api" || failure.kind === "cancelled" ? "network" : failure.kind)
  );
}
