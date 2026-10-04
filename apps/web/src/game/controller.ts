import type { GameSnapshot } from "@neurochess/contracts";

import type { SandboxApi } from "../api/client";
import type { GameTarget } from "../app/navigation";

import { ArchiveController } from "./archive";
import { failureNotice, isAccessCode, safeFailure } from "./failures";
import { OperationGate } from "./operations";
import { browserPgnDelivery, type PgnDelivery } from "./pgn";
import { RecoveryController } from "./recovery";
import { GameSession } from "./session";
import {
  isTerminal,
  isUnfinished,
  type LifecycleAction,
  type SandboxNotice,
  type SandboxState,
} from "./state";
import { SandboxStore } from "./store";

export interface SandboxEntry {
  readonly target: GameTarget;
  readonly snapshot: GameSnapshot | null;
  readonly readiness: boolean;
  readonly issue?: {
    readonly phase: "unavailable" | "access-error" | "recovery-required";
    readonly notice: SandboxNotice;
  };
}

export type SandboxGameNavigation = (gameId: string, reason: "created" | "recovered") => void;

/** Composes command serialization, paused recovery, private replay, and explicit creation. */
export class SandboxController {
  private readonly store = new SandboxStore();
  private readonly gate = new OperationGate();
  private readonly archive: ArchiveController;
  private readonly session: GameSession;
  private readonly recovery: RecoveryController;
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

  endLifetime(): void {
    if (this.ended) return;
    this.ended = true;
    this.gate.disconnect();
    this.archive.cancel();
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
      this.store.setReadiness(entry.readiness ? "ready" : "unavailable");
    }
    if (entry.issue) {
      this.store.transition(
        { phase: entry.issue.phase, snapshot: null, pendingCommand: null },
        { notice: entry.issue.notice },
      );
    } else {
      await this.recovery.recover(this.target, entry.snapshot);
    }
  }

  private acceptCreated(snapshot: GameSnapshot): void {
    this.archive.cancel();
    this.target = { kind: "game", gameId: snapshot.gameId };
    this.session.accept(snapshot, "started", null);
    this.onGame?.(snapshot.gameId, "created");
  }

  setReadiness(ready: boolean): void {
    const readiness = ready ? "ready" : "unavailable";
    const previous = this.store.get().readiness;
    if (this.gate.isConnected() && previous !== readiness) {
      this.store.setReadiness(readiness, previous === "unavailable" || !ready);
    }
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
