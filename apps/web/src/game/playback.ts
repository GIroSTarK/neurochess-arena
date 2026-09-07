import type {
  AiTurnCommand,
  ChessColor,
  GameSnapshot,
  SessionCredential,
} from "@neurochess/contracts";

import type { AiTurnApi } from "../api/ai";
import { ApiFailure, type SandboxApi } from "../api/client";

import { ArchiveController } from "./archive";
import { safeFailure } from "./failures";
import { type Operation, OperationGate } from "./operations";
import { browserPgnDelivery, type PgnDelivery } from "./pgn";
import { RecoveryController } from "./recovery";
import { GameSession } from "./session";
import {
  isTerminal,
  isUnfinished,
  type LifecycleAction,
  sameSnapshot,
  type SandboxState,
} from "./state";
import { SandboxStore } from "./store";

export type PlaybackSpeed = 0.5 | 1 | 2;
export interface PlaybackState {
  readonly game: SandboxState;
  readonly activity: "idle" | "thinking" | "synchronizing" | "uncertain";
  readonly automatic: boolean;
  readonly speed: PlaybackSpeed;
  readonly control: LifecycleAction["action"] | null;
}

interface PlaybackOptions {
  readonly recovered: boolean;
  readonly isAiGame?: boolean;
  readonly humanColor?: ChessColor;
  // This accessor reads page memory. Credentials never enter observable controller state.
  readonly credential: (color: ChessColor) => SessionCredential | null;
}

export class AiPlaybackController {
  private readonly store = new SandboxStore();
  private readonly gate = new OperationGate();
  private readonly session: GameSession;
  private readonly archive: ArchiveController;
  private readonly recovery: RecoveryController;
  private readonly listeners = new Set<() => void>();
  private state: PlaybackState;
  private connected = false;
  private startOnConnect: boolean;
  private recoverOnConnect: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingTurn: AiTurnCommand | null = null;
  private lifecycleGeneration = 0;

  constructor(
    private readonly api: SandboxApi,
    private readonly ai: AiTurnApi,
    initial: GameSnapshot,
    private readonly options: PlaybackOptions,
    private readonly commandId: () => string = () => crypto.randomUUID(),
    delivery: PgnDelivery = browserPgnDelivery,
  ) {
    const { store, gate } = this;
    store.transition({ phase: "ready", snapshot: initial, pendingCommand: null }, { notice: null });
    this.state = { game: store.get(), activity: "idle", automatic: false, speed: 1, control: null };
    store.subscribe(() => this.publish({}));
    this.archive = new ArchiveController({
      api,
      delivery,
      store,
      isConnected: () => this.connected,
      loseAccess: (failure) => this.session.loseAccess(failure),
    });
    this.session = new GameSession({
      api,
      store,
      gate,
      commandId,
      archive: this.archive,
    });
    this.recovery = new RecoveryController({
      api,
      store,
      gate,
      commandId,
      session: this.session,
      navigation: undefined,
      pausePaused: options.isAiGame !== false,
    });
    this.recoverOnConnect = options.recovered;
    this.startOnConnect = !options.recovered && initial.state === "active";
  }

  readonly getSnapshot = (): PlaybackState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(): () => void {
    if (!this.connected) {
      this.connected = true;
      this.gate.connect();
      const { snapshot, replay } = this.store.get();
      if (snapshot && isTerminal(snapshot)) {
        if (!replay) void this.loadReplay();
      } else if (this.recoverOnConnect) void this.recover();
      else if (this.startOnConnect && this.ready()) {
        this.publish({ automatic: true });
        // Defer the first request so StrictMode's setup/cleanup replay cannot bill a turn.
        this.schedule(0);
      }
    }
    return () => this.disconnect();
  }

  disconnect(): void {
    this.lifecycleGeneration += 1;
    this.connected = false;
    this.cancelTimer();
    this.gate.disconnect();
    this.archive.cancel();
    const { snapshot, pendingCommand, phase } = this.store.get();
    if (pendingCommand) {
      this.store.transition(
        { phase: "uncertain", snapshot, pendingCommand },
        { notice: "uncertain" },
      );
    } else if (phase === "synchronizing") {
      this.store.transition(
        { phase: "sync-required", snapshot, pendingCommand: null },
        { notice: "sync-required" },
      );
    } else if (phase === "recovering") {
      this.store.transition(
        { phase: "recovery-required", snapshot, pendingCommand: null },
        { notice: "recovery-required" },
      );
    }
    this.publish({
      automatic: false,
      control: null,
      activity: this.pendingTurn ? "uncertain" : "idle",
    });
  }

  suspend(): void {
    this.startOnConnect = false;
    this.recoverOnConnect = true;
    this.disconnect();
    this.session.beginRecovery();
    const { snapshot, pendingCommand } = this.store.get();
    if (snapshot && isUnfinished(snapshot) && !pendingCommand) {
      this.store.transition(
        { phase: "recovery-required", snapshot, pendingCommand: null },
        { notice: "recovery-required", invalidateInteraction: true },
      );
    }
  }

  leave(): void {
    const snapshot = this.store.get().snapshot;
    this.suspend();
    if (snapshot && isUnfinished(snapshot)) {
      this.ai.leave?.({
        action: "pause",
        gameId: snapshot.gameId,
        expectedVersion: snapshot.version,
        commandId: this.commandId(),
      });
    }
  }

  setSpeed(speed: PlaybackSpeed): void {
    if (![0.5, 1, 2].includes(speed)) return;
    this.publish({ speed });
    if (this.timer !== null) this.schedule();
  }

  loadReplay(): Promise<void> {
    return this.archive.loadReplay();
  }

  selectPly(ply: number): void {
    this.archive.selectPly(ply);
  }

  exportPgn(action: "copy" | "download"): Promise<void> {
    return this.archive.exportPgn(action);
  }

  async resume(): Promise<void> {
    if (!this.ready() || this.state.automatic) return;
    if (this.store.get().snapshot?.state === "paused") await this.lifecycle({ action: "resume" });
    else {
      this.publish({ automatic: true });
      this.schedule(0);
    }
  }

  async next(): Promise<void> {
    if (!this.ready() || !this.isAiTurn() || this.store.get().snapshot?.state !== "paused") return;
    this.halt();
    await this.turn();
  }

  pause(): Promise<void> {
    return this.lifecycle({ action: "pause" });
  }
  stop(): Promise<void> {
    return this.lifecycle({ action: "abort" });
  }

  canMove(): boolean {
    const snapshot = this.store.get().snapshot;
    return (
      this.ready() &&
      this.state.automatic &&
      snapshot?.state === "active" &&
      snapshot.turn === this.options.humanColor
    );
  }

  async submit(move: string): Promise<void> {
    if (!this.canMove() || !this.store.get().snapshot?.legalMoves.includes(move)) return;
    const generation = this.lifecycleGeneration;
    await this.session.submit(move);
    if (this.isLifecycleCurrent(generation)) this.afterHumanCommand();
  }

  resign(losingColor: ChessColor): Promise<void> {
    if (losingColor !== this.options.humanColor) return Promise.resolve();
    return this.lifecycle({ action: "resign", losingColor });
  }

  async recover(): Promise<void> {
    this.halt();
    await this.recovery.recover();
    if (this.store.get().phase === "ready") this.recoverOnConnect = false;
    this.resolvePendingTurn();
  }

  async retryCommand(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const pending = this.store.get().pendingCommand;
    this.halt();
    await this.session.retryCommand();
    if (!this.isLifecycleCurrent(generation)) return;
    this.resolvePendingTurn();
    if (pending && "move" in pending) this.afterHumanCommand();
  }

  async synchronize(): Promise<void> {
    this.halt();
    if (this.pendingTurn) {
      const operation = this.gate.begin();
      if (!operation) return;
      try {
        await this.reconcile(operation, this.pendingTurn);
      } finally {
        this.gate.finish(operation);
      }
    } else await this.session.synchronize();
  }

  private publish(change: Partial<Omit<PlaybackState, "game">>): void {
    this.state = { ...this.state, ...change, game: this.store.get() };
    this.listeners.forEach((listener) => listener());
  }

  private ready(): boolean {
    const { phase, snapshot } = this.store.get();
    return (
      this.connected &&
      !this.state.control &&
      this.state.activity === "idle" &&
      phase === "ready" &&
      isUnfinished(snapshot) &&
      (this.options.humanColor === "white" || this.options.credential("white") !== null) &&
      (this.options.humanColor === "black" || this.options.credential("black") !== null)
    );
  }

  private isAiTurn(): boolean {
    return this.store.get().snapshot?.turn !== this.options.humanColor;
  }

  private afterHumanCommand(): void {
    const { snapshot, notice } = this.store.get();
    if (this.ready() && snapshot?.state === "active" && notice === null) {
      this.publish({ automatic: true });
      this.schedule(0);
    } else this.halt();
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private halt(): void {
    this.startOnConnect = false;
    this.cancelTimer();
    this.publish({ automatic: false });
  }

  private schedule(delay = 1_000 / this.state.speed): void {
    this.cancelTimer();
    if (
      !this.state.automatic ||
      !this.ready() ||
      !this.isAiTurn() ||
      this.store.get().snapshot?.state !== "active"
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.turn();
    }, delay);
  }

  private async turn(): Promise<void> {
    if (!this.ready() || !this.isAiTurn()) return;
    const before = this.store.get().snapshot;
    if (!before) return;
    const credential = this.options.credential(before.turn);
    if (!credential) return;
    const operation = this.gate.begin();
    if (!operation) return;
    this.startOnConnect = false;
    const command: AiTurnCommand = {
      gameId: before.gameId,
      expectedVersion: before.version,
      commandId: this.commandId(),
    };
    this.pendingTurn = command;
    this.publish({ activity: "thinking" });
    try {
      const snapshot = await this.ai.turn(command, credential, operation.abort.signal);
      if (!this.gate.isCurrent(operation)) return;
      if (!this.valid(snapshot, command) || snapshot.version <= command.expectedVersion) {
        throw new ApiFailure("malformed");
      }
      this.pendingTurn = null;
      this.session.accept(
        snapshot,
        snapshot.moves.length > before.moves.length ? "move" : "lifecycle",
        null,
      );
      this.publish({ activity: "idle" });
      if (snapshot.state !== "active") this.halt();
    } catch (error: unknown) {
      if (!this.gate.isCurrent(operation)) return;
      this.halt();
      const failure = safeFailure(error);
      if (failure.kind === "restart") {
        this.gate.finish(operation);
        await this.recover();
      } else if (this.session.loseAccess(failure)) {
        this.pendingTurn = null;
        this.publish({ activity: "idle" });
      } else await this.reconcile(operation, command, failure.currentSnapshot);
    } finally {
      if (this.gate.isCurrent(operation)) {
        this.gate.finish(operation);
        this.schedule();
      }
    }
  }

  private valid(snapshot: GameSnapshot, command: AiTurnCommand): boolean {
    const current = this.store.get().snapshot;
    return (
      this.session.validRevision(snapshot, command.gameId) &&
      (snapshot.version !== current?.version || sameSnapshot(snapshot, current))
    );
  }

  private async reconcile(
    operation: Operation,
    command: AiTurnCommand,
    conflict?: GameSnapshot,
  ): Promise<void> {
    this.publish({ activity: "synchronizing" });
    try {
      const snapshot =
        conflict ?? (await this.api.snapshot(command.gameId, operation.abort.signal));
      if (!this.gate.isCurrent(operation)) return;
      if (!this.valid(snapshot, command)) throw new ApiFailure("malformed");
      if (snapshot.version > command.expectedVersion) {
        this.pendingTurn = null;
        this.session.accept(snapshot, "synchronized", "synchronized");
        this.publish({ activity: "idle" });
      } else {
        // A same-version conflict or GET cannot establish whether the POST will commit later.
        if (["ready", "sync-required"].includes(this.store.get().phase)) {
          this.session.accept(snapshot, "synchronized", "synchronized");
        }
        this.publish({ activity: "uncertain" });
      }
    } catch (error: unknown) {
      if (!this.gate.isCurrent(operation)) return;
      if (this.session.loseAccess(safeFailure(error))) this.pendingTurn = null;
      this.publish({ activity: this.pendingTurn ? "uncertain" : "idle" });
    }
  }

  private resolvePendingTurn(): void {
    const snapshot = this.store.get().snapshot;
    if (!snapshot || (this.pendingTurn && snapshot.version > this.pendingTurn.expectedVersion)) {
      this.pendingTurn = null;
    }
    this.publish({ activity: this.pendingTurn ? "uncertain" : "idle" });
  }

  private async lifecycle(command: LifecycleAction): Promise<void> {
    const { action } = command;
    const { phase, snapshot } = this.store.get();
    if (!this.connected || this.state.control || phase !== "ready" || !isUnfinished(snapshot)) {
      return;
    }
    const generation = ++this.lifecycleGeneration;
    this.halt();
    // The lifecycle lane supersedes the AI request without waiting for provider I/O. Its
    // accepted revision, not client cancellation, is what prevents a late move committing.
    if (this.pendingTurn) this.gate.invalidate();
    this.publish({ control: action });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.session.lifecycle(command);
      if (!this.isLifecycleCurrent(generation)) return;
      this.resolvePendingTurn();
      const current = this.store.get();
      if (current.phase !== "ready" || isTerminal(current.snapshot)) break;
      const target = { pause: "paused", resume: "active", abort: "aborted", resign: "completed" }[
        action
      ];
      if (current.snapshot.state === target && !this.pendingTurn) break;
      // If the move won the server lock, finish the user's pause/stop against its revision.
      if (current.notice !== "GAME_CONFLICT" || action === "resume") break;
    }
    this.publish({ control: null });
    const current = this.store.get();
    if (
      action === "resume" &&
      this.ready() &&
      current.snapshot?.state === "active" &&
      current.notice !== "GAME_CONFLICT"
    ) {
      this.publish({ automatic: true });
      this.schedule(0);
    }
  }

  private isLifecycleCurrent(generation: number): boolean {
    return this.connected && generation === this.lifecycleGeneration;
  }
}
