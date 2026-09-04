import type { SandboxApi } from "../api/client";

import { ArchiveController } from "./archive";
import { failureNotice, safeFailure } from "./failures";
import type { SandboxNavigation } from "./navigation";
import { OperationGate } from "./operations";
import { browserPgnDelivery, type PgnDelivery } from "./pgn";
import { RecoveryController } from "./recovery";
import { GameSession } from "./session";
import {
  initialSandboxState,
  isTerminal,
  isUnfinished,
  type LifecycleAction,
  type SandboxState,
} from "./state";
import { Store } from "./store";

/**
 * Facade over the sandbox client. It composes the store, the serial operation gate, the game
 * session, paused recovery, and the terminal-game archive, and owns what is specific to the
 * sandbox entry flow: service readiness, guest bootstrap and creation, and URL history.
 */
export class SandboxController {
  private readonly store = new Store<SandboxState>(initialSandboxState);
  private readonly gate = new OperationGate();
  private readonly archive: ArchiveController;
  private readonly session: GameSession;
  private readonly recovery: RecoveryController;
  private readinessAbort: AbortController | null = null;
  private unsubscribeNavigation: (() => void) | null = null;

  constructor(
    private readonly api: SandboxApi,
    commandId: () => string = () => crypto.randomUUID(),
    private readonly navigation?: SandboxNavigation,
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
      navigation,
      session: this.session,
    });
  }

  readonly getSnapshot = (): SandboxState => this.store.get();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  connect(): () => void {
    this.gate.connect();
    void this.checkReadiness();
    this.unsubscribeNavigation?.();
    this.unsubscribeNavigation =
      this.navigation?.subscribe(() => {
        // History navigation cancels obsolete requests and clears private view state.
        this.gate.invalidate();
        this.archive.clear();
        this.store.patch({ snapshot: null, pendingCommand: null, phase: "entry", notice: null });
        void this.recovery.recover();
      }) ?? null;
    const { snapshot, pendingCommand, replay } = this.store.get();
    if (!snapshot && !pendingCommand) void this.recovery.recover();
    else if (snapshot && isTerminal(snapshot) && !replay) void this.archive.loadReplay();
    return () => this.disconnect();
  }

  disconnect(): void {
    this.gate.disconnect();
    this.readinessAbort?.abort();
    this.readinessAbort = null;
    this.unsubscribeNavigation?.();
    this.unsubscribeNavigation = null;
    this.archive.cancel();
    const { phase, snapshot, pendingCommand } = this.store.get();
    if (pendingCommand) {
      this.store.patch({ phase: "uncertain", notice: "uncertain" });
    } else if (phase === "synchronizing") {
      this.store.patch({ phase: "sync-required", notice: "sync-required" });
    } else if (phase === "starting") {
      this.store.patch({ phase: snapshot ? "ready" : "entry" });
    } else if (phase === "recovering") {
      this.store.patch({ phase: "recovery-required", notice: "recovery-required" });
    }
  }

  async checkReadiness(): Promise<void> {
    if (!this.gate.isConnected() || this.readinessAbort) return;
    const abort = new AbortController();
    this.readinessAbort = abort;
    const isRetry = this.store.get().readiness === "unavailable";
    this.store.patch({ readiness: "checking" });
    let readiness: "ready" | "unavailable" = "unavailable";
    try {
      readiness = (await this.api.ready(abort.signal)) ? "ready" : "unavailable";
    } catch {
      // Readiness does not decide sandbox availability or replace a guest.
    }
    if (!this.gate.isConnected() || abort.signal.aborted) return;
    this.readinessAbort = null;
    this.store.patch({
      readiness,
      ...(isRetry || readiness === "unavailable"
        ? { announcement: { kind: "connection", readiness } as const }
        : {}),
    });
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
    this.store.patch({ phase: "starting", notice: null });
    try {
      // The cookie must exist before creation. No mount effect bootstraps guests.
      await this.api.bootstrap(operation.abort.signal);
      if (!this.gate.isCurrent(operation)) return;
      const created = await this.api.create(operation.abort.signal);
      if (this.gate.isCurrent(operation)) {
        this.archive.clear();
        this.navigation?.open(created.gameId);
        this.session.accept(created, "started", null);
      }
    } catch (error: unknown) {
      if (!this.gate.isCurrent(operation)) return;
      const failure = safeFailure(error);
      this.archive.clear();
      if (failure.code === "GAME_CONFLICT" && failure.currentSnapshot) {
        // The occupied slot is the authorized game; reopen it paused.
        await this.recovery.pauseRecovered(operation, failure.currentSnapshot);
      } else {
        const unavailable = failure.code === "NOT_FOUND";
        const notice = unavailable ? "sandbox-unavailable" : failureNotice(failure);
        this.store.patch({
          snapshot: null,
          pendingCommand: null,
          phase: unavailable ? "unavailable" : "entry",
          notice,
          announcement: { kind: "notice", notice },
          interactionRevision: this.store.get().interactionRevision + 1,
        });
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
    return this.recovery.recover();
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
