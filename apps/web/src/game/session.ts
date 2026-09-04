import type { GameSnapshot, LifecycleCommand, MoveCommand } from "@neurochess/contracts";

import { ApiFailure, type SandboxApi } from "../api/client";

import type { ArchiveController } from "./archive";
import { isAccessCode, rejectionOf, safeFailure } from "./failures";
import type { Operation, OperationGate } from "./operations";
import {
  isTerminal,
  type AcceptedKind,
  type Announcement,
  type LifecycleAction,
  type PendingCommand,
  type SandboxNotice,
  type SandboxState,
} from "./state";
import type { Store } from "./store";

export interface SessionContext {
  readonly api: Pick<SandboxApi, "move" | "lifecycle" | "snapshot">;
  readonly store: Store<SandboxState>;
  readonly gate: OperationGate;
  readonly commandId: () => string;
  readonly archive: Pick<ArchiveController, "clear" | "loadReplay">;
}

/**
 * Owns the accepted snapshot and the versioned commands issued against it. Commands run one
 * at a time through the operation gate. A failed response is never resent implicitly: the
 * accepted position is read back, and an uncertain command is retained for an explicit retry
 * with the identical identifier, revision, and payload.
 */
export class GameSession {
  private recovering = false;

  constructor(private readonly context: SessionContext) {}

  /** While recovery runs, an accepted active snapshot must not become playable. */
  beginRecovery(): void {
    this.recovering = true;
  }

  endRecovery(): void {
    this.recovering = false;
  }

  async submit(move: string): Promise<void> {
    const { phase, snapshot } = this.context.store.get();
    if (
      phase !== "ready" ||
      !snapshot ||
      snapshot.state !== "active" ||
      !snapshot.legalMoves.includes(move)
    )
      return;
    // Acquired synchronously, before generating a command or notifying React.
    const operation = this.context.gate.begin();
    if (!operation) return;
    const command: MoveCommand = {
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: this.context.commandId(),
      move,
    };
    this.context.store.patch({ pendingCommand: command });
    await this.sendCommand(operation, command);
  }

  async lifecycle(action: LifecycleAction): Promise<void> {
    const { phase, snapshot } = this.context.store.get();
    if (phase !== "ready" || !snapshot || isTerminal(snapshot)) return;
    const operation = this.context.gate.begin();
    if (!operation) return;
    const command: LifecycleCommand = {
      ...action,
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: this.context.commandId(),
    };
    this.context.store.patch({ pendingCommand: command });
    await this.sendCommand(operation, command);
  }

  /** Resends the retained uncertain command unchanged. */
  async retryCommand(): Promise<void> {
    const { phase, pendingCommand } = this.context.store.get();
    if (phase !== "uncertain" || !pendingCommand) return;
    const operation = this.context.gate.begin();
    if (operation) await this.sendCommand(operation, pendingCommand);
  }

  async synchronize(): Promise<void> {
    const { phase, snapshot } = this.context.store.get();
    if ((phase !== "uncertain" && phase !== "sync-required") || !snapshot) return;
    const operation = this.context.gate.begin();
    if (!operation) return;
    try {
      await this.readBack(operation);
    } finally {
      this.context.gate.finish(operation);
    }
  }

  /** A response must belong to the loaded game and never regress the accepted revision. */
  validRevision(snapshot: GameSnapshot, gameId: string): boolean {
    return (
      snapshot.gameId === gameId &&
      snapshot.version >= (this.context.store.get().snapshot?.version ?? 0)
    );
  }

  /** Clears all private game data on an access failure; explicit action is required afterwards. */
  loseAccess(failure: ApiFailure): boolean {
    if (!isAccessCode(failure.code)) return false;
    const { store, archive } = this.context;
    store.patch({
      snapshot: null,
      pendingCommand: null,
      phase: "access-error",
      notice: failure.code,
      announcement: { kind: "notice", notice: failure.code },
      interactionRevision: store.get().interactionRevision + 1,
    });
    archive.clear();
    this.recovering = false;
    return true;
  }

  accept(
    snapshot: GameSnapshot,
    kind: AcceptedKind,
    notice: SandboxNotice | null,
    announcement?: Announcement,
  ): void {
    const { store, archive } = this.context;
    const needsPause = this.recovering && snapshot.state === "active";
    if (!needsPause) this.recovering = false;
    store.patch({
      snapshot,
      pendingCommand: null,
      phase: needsPause ? "recovery-required" : "ready",
      notice: needsPause ? "recovery-required" : notice,
      announcement: announcement ?? { kind, snapshot },
      interactionRevision: store.get().interactionRevision + 1,
    });
    if (isTerminal(snapshot) && !store.get().replay) void archive.loadReplay();
  }

  /** Reads the authorized snapshot after a failure; an unchanged revision keeps a command uncertain. */
  async readBack(operation: Operation, rejection?: SandboxNotice): Promise<void> {
    const { api, store, gate } = this.context;
    const accepted = store.get().snapshot;
    if (!accepted || !gate.isCurrent(operation)) return;
    store.patch({ phase: "synchronizing", notice: rejection ?? null });
    try {
      const snapshot = await api.snapshot(accepted.gameId, operation.abort.signal);
      if (!gate.isCurrent(operation)) return;
      if (!this.validRevision(snapshot, accepted.gameId)) throw new ApiFailure("malformed");
      const pending = store.get().pendingCommand;
      if (pending && snapshot.version === pending.expectedVersion) {
        // An unchanged GET cannot prove a timed-out POST will not commit later.
        store.patch({
          snapshot,
          phase: "uncertain",
          notice: "uncertain",
          announcement: { kind: "notice", notice: "uncertain" },
          interactionRevision: store.get().interactionRevision + 1,
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
      if (!gate.isCurrent(operation)) return;
      if (this.loseAccess(safeFailure(error))) return;
      const pending = store.get().pendingCommand !== null;
      const notice = pending ? "uncertain" : "sync-required";
      store.patch({
        phase: pending ? "uncertain" : "sync-required",
        notice,
        announcement: { kind: "notice", notice },
      });
    }
  }

  private async sendCommand(operation: Operation, command: PendingCommand): Promise<void> {
    const { api, store, gate } = this.context;
    store.patch({ phase: "submitting", notice: null });
    try {
      const snapshot = await ("move" in command
        ? api.move(command, operation.abort.signal)
        : api.lifecycle(command, operation.abort.signal));
      if (!gate.isCurrent(operation)) return;
      if (
        !this.validRevision(snapshot, command.gameId) ||
        snapshot.version <= command.expectedVersion ||
        !matchesCommand(snapshot, command)
      ) {
        throw new ApiFailure("malformed");
      }
      this.accept(snapshot, "move" in command ? "move" : "lifecycle", null);
    } catch (error: unknown) {
      if (!gate.isCurrent(operation)) return;
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
      const rejection = rejectionOf(failure);
      if (rejection) store.patch({ pendingCommand: null });
      // A failed response can follow a committed write. Never resend implicitly.
      await this.readBack(operation, rejection);
    } finally {
      gate.finish(operation);
    }
  }
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
