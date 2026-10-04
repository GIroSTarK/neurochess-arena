import type { GameSnapshot } from "@neurochess/contracts";

import type { SandboxApi } from "../api/client";
import type { GameTarget } from "../app/navigation";

import { ArchiveController } from "./archive";
import { failureNotice, isAccessCode, safeFailure } from "./failures";
import { OperationGate } from "./operations";
import { browserPgnDelivery, type PgnDelivery } from "./pgn";
import { RecoveryController } from "./recovery";
import { GameSession } from "./session";
import { isTerminal, isUnfinished, type LifecycleAction, type SandboxState } from "./state";
import { SandboxStore } from "./store";

export interface SandboxEntry {
  readonly target: GameTarget;
  readonly snapshot?: GameSnapshot | null;
  readonly readiness?: boolean;
}

export type SandboxGameNavigation = (gameId: string, reason: "created" | "recovered") => void;

/** Composes command serialization, paused recovery, private replay, and explicit creation. */
export class SandboxController {
  private readonly store = new SandboxStore();
  private readonly gate = new OperationGate();
  private readonly archive: ArchiveController;
  private readonly session: GameSession;
  private readonly recovery: RecoveryController;
  private readinessAbort: AbortController | null = null;
  private target: GameTarget = { kind: "none" };
  private ended = false;

  constructor(
    private readonly api: SandboxApi,
    commandId: () => string = () => crypto.randomUUID(),
    private readonly onGame?: SandboxGameNavigation,
    delivery: PgnDelivery = browserPgnDelivery,
  ) {
    const { store, gate } = this;
    this.archive = new ArchiveController({
      api,
      delivery,
      store,
      isConnected: () => gate.isConnected(),
      loseAccess: (failure) => this.session.loseAccess(failure),
    });
    this.session = new GameSession({ api, store, gate, commandId, archive: this.archive });
    this.recovery = new RecoveryController({
      api,
      store,
      gate,
      commandId,
      onGame: (gameId) => {
        this.target = { kind: "game", gameId };
        this.onGame?.(gameId, "recovered");
      },
      session: this.session,
    });
  }

  readonly getSnapshot = (): SandboxState => this.store.get();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  connect(entry?: SandboxEntry): () => void {
    if (entry) {
      void this.enter(entry);
      return () => this.disconnect();
    }
    this.ended = false;
    this.gate.connect();
    void this.checkReadiness();
    const { snapshot, replay } = this.store.get();
    if (!snapshot) void this.recover();
    else if (isTerminal(snapshot) && !replay) void this.archive.loadReplay();
    return () => this.disconnect();
  }

  disconnect(): void {
    this.gate.disconnect();
    this.readinessAbort?.abort();
    this.readinessAbort = null;
    this.archive.cancel();
    const { phase, snapshot, pendingCommand } = this.store.get();
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
    } else if (phase === "starting") {
      this.store.transition(
        snapshot
          ? { phase: "ready", snapshot, pendingCommand: null }
          : { phase: "entry", snapshot: null, pendingCommand: null },
        { notice: this.store.get().notice },
      );
    } else if (phase === "recovering") {
      this.store.transition(
        { phase: "recovery-required", snapshot, pendingCommand: null },
        { notice: "recovery-required" },
      );
    }
  }

  endLifetime(): void {
    if (this.ended) return;
    this.ended = true;
    this.disconnect();
    this.session.endRecovery();
    this.store.transition(
      { phase: "entry", snapshot: null, pendingCommand: null },
      { notice: null, invalidateInteraction: true },
    );
  }

  async enter(entry: SandboxEntry): Promise<void> {
    this.endLifetime();
    this.ended = false;
    this.gate.connect();
    this.target = entry.target;
    if (entry.target.kind !== "invalid") {
      if (entry.readiness === undefined) void this.checkReadiness();
      else this.store.setReadiness(entry.readiness ? "ready" : "unavailable");
    }
    await this.recovery.recover(this.target, entry.snapshot);
  }

  private acceptCreated(snapshot: GameSnapshot): void {
    this.archive.cancel();
    this.target = { kind: "game", gameId: snapshot.gameId };
    this.session.accept(snapshot, "started", null);
    this.onGame?.(snapshot.gameId, "created");
  }

  async checkReadiness(): Promise<void> {
    if (!this.gate.isConnected() || this.readinessAbort) return;
    const abort = new AbortController();
    this.readinessAbort = abort;
    const isRetry = this.store.get().readiness === "unavailable";
    this.store.setReadiness("checking");
    let readiness: "ready" | "unavailable" = "unavailable";
    try {
      readiness = (await this.api.ready(abort.signal)) ? "ready" : "unavailable";
    } catch {
      // Readiness does not decide sandbox availability or replace a guest.
    }
    if (!this.gate.isConnected() || abort.signal.aborted) return;
    this.readinessAbort = null;
    this.store.setReadiness(readiness, isRetry || readiness === "unavailable");
  }

  /** Bootstraps the guest cookie, then creates a sandbox game. Only this explicit action bootstraps. */
  async start(): Promise<void> {
    const { readiness, snapshot, pendingCommand, phase } = this.store.get();
    if (
      readiness !== "ready" ||
      (snapshot !== null && isUnfinished(snapshot)) ||
      pendingCommand ||
      phase === "recovering" ||
      phase === "recovery-required"
    ) {
      return;
    }
    const operation = this.gate.begin();
    if (!operation) return;
    this.store.transition({ phase: "starting", snapshot, pendingCommand: null }, { notice: null });
    try {
      await this.api.bootstrap(operation.abort.signal);
      if (!this.gate.isCurrent(operation)) return;
      const created = await this.api.create(operation.abort.signal);
      if (this.gate.isCurrent(operation)) {
        this.acceptCreated(created);
      }
    } catch (error: unknown) {
      if (!this.gate.isCurrent(operation)) return;
      const failure = safeFailure(error);
      if (failure.code === "GAME_CONFLICT" && failure.currentSnapshot) {
        // The occupied slot is the authorized game; reopen it paused.
        this.archive.cancel();
        await this.recovery.pauseRecovered(operation, failure.currentSnapshot);
      } else {
        const unavailable = failure.code === "NOT_FOUND";
        const notice = unavailable ? "sandbox-unavailable" : failureNotice(failure);
        const retained = this.store.get().snapshot;
        if (retained && isTerminal(retained) && !isAccessCode(failure.code)) {
          this.store.transition(
            { snapshot: retained, pendingCommand: null, phase: "ready" },
            { notice, announcement: { kind: "notice", notice } },
          );
          return;
        }
        this.archive.cancel();
        this.store.transition(
          { snapshot: null, pendingCommand: null, phase: unavailable ? "unavailable" : "entry" },
          { notice, announcement: { kind: "notice", notice }, invalidateInteraction: true },
        );
      }
    } finally {
      this.gate.finish(operation);
    }
  }

  submit(move: string): Promise<void> {
    return this.session.submit(move);
  }

  lifecycle(action: LifecycleAction): Promise<void> {
    return this.session.lifecycle(action);
  }

  retryCommand(): Promise<void> {
    return this.session.retryCommand();
  }

  synchronize(): Promise<void> {
    return this.session.synchronize();
  }

  recover(): Promise<void> {
    return this.recovery.recover(this.target);
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
}
