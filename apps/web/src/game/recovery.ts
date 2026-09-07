import type { GameSnapshot, LifecycleCommand } from "@neurochess/contracts";

import { ApiFailure, type SandboxApi } from "../api/client";

import { failureNotice, rejectionOf, safeFailure } from "./failures";
import type { SandboxNavigation } from "./navigation";
import type { Operation, OperationGate } from "./operations";
import type { GameSession } from "./session";
import { isTerminal } from "./state";
import type { SandboxStore } from "./store";

export interface RecoveryContext {
  readonly api: Pick<SandboxApi, "snapshot" | "unfinished" | "lifecycle">;
  readonly store: SandboxStore;
  readonly gate: OperationGate;
  readonly commandId: () => string;
  readonly navigation: SandboxNavigation | undefined;
  readonly pausePaused?: boolean;
  readonly session: Pick<
    GameSession,
    "accept" | "loseAccess" | "readBack" | "validRevision" | "beginRecovery" | "endRecovery"
  >;
}

/** Concurrent active snapshots are reconciled with at most this many pause attempts. */
const PAUSE_ATTEMPTS = 3;

/**
 * Reopens an existing game as paused. The URL's game, or the guest's unfinished sandbox, is
 * read through guest authorization and then paused with the same versioned command as the
 * Pause control. Reads never change lifecycle, and no recovered active snapshot enables play.
 */
export class RecoveryController {
  constructor(private readonly context: RecoveryContext) {}

  async recover(): Promise<void> {
    const { api, store, gate, navigation, session } = this.context;
    if (store.get().pendingCommand) return;
    const operation = gate.begin();
    if (!operation) return;
    const target = navigation?.read() ?? { kind: "none" as const };
    const gameId =
      target.kind === "game"
        ? target.gameId
        : target.kind === "none"
          ? (store.get().snapshot?.gameId ?? null)
          : null;
    // Anonymous discovery may find nothing; a linked game must exist and be accessible.
    const discovery = target.kind === "none" && gameId === null;
    session.beginRecovery();
    store.transition(
      { phase: "recovering", snapshot: store.get().snapshot, pendingCommand: null },
      { notice: null },
    );
    try {
      if (target.kind === "invalid") throw new ApiFailure("api", "NOT_FOUND");
      const snapshot = gameId
        ? await api.snapshot(gameId, operation.abort.signal)
        : await api.unfinished(operation.abort.signal);
      if (!gate.isCurrent(operation)) return;
      if (snapshot) {
        if (gameId && !session.validRevision(snapshot, gameId)) throw new ApiFailure("malformed");
        await this.pauseRecovered(operation, snapshot);
      } else {
        session.endRecovery();
        store.transition(
          { phase: "entry", snapshot: null, pendingCommand: null },
          { notice: null },
        );
      }
    } catch (error: unknown) {
      if (!gate.isCurrent(operation)) return;
      const failure = safeFailure(error);
      if (discovery && failure.code === "UNAUTHORIZED") {
        session.endRecovery();
        store.transition(
          { phase: "entry", snapshot: null, pendingCommand: null },
          { notice: null },
        );
      } else if (discovery && failure.code === "NOT_FOUND") {
        session.endRecovery();
        store.transition(
          { phase: "unavailable", snapshot: null, pendingCommand: null },
          { notice: "sandbox-unavailable" },
        );
      } else if (!session.loseAccess(failure)) {
        store.transition(
          { phase: "recovery-required", snapshot: store.get().snapshot, pendingCommand: null },
          { notice: failureNotice(failure) },
        );
      }
    } finally {
      gate.finish(operation);
    }
  }

  async pauseRecovered(operation: Operation, initial: GameSnapshot): Promise<void> {
    const { api, store, gate, navigation, session } = this.context;
    session.beginRecovery();
    navigation?.open(initial.gameId, true);
    let snapshot = initial;
    for (let attempt = 0; attempt < PAUSE_ATTEMPTS; attempt += 1) {
      if (!gate.isCurrent(operation)) return;
      store.transition(
        { snapshot, pendingCommand: null, phase: "recovering" },
        { notice: store.get().notice, invalidateInteraction: true },
      );
      if (snapshot.state !== "active" && snapshot.state !== "paused" && !isTerminal(snapshot)) {
        throw new ApiFailure("malformed");
      }
      if (isTerminal(snapshot) || (snapshot.state === "paused" && !this.context.pausePaused)) {
        session.accept(snapshot, "existing", "existing");
        return;
      }
      const command: LifecycleCommand = {
        action: "pause",
        gameId: snapshot.gameId,
        expectedVersion: snapshot.version,
        commandId: this.context.commandId(),
      };
      store.transition(
        { phase: "recovering", snapshot, pendingCommand: command },
        { notice: store.get().notice },
      );
      try {
        const paused = await api.lifecycle(command, operation.abort.signal);
        if (!gate.isCurrent(operation)) return;
        if (
          !session.validRevision(paused, snapshot.gameId) ||
          paused.version <= snapshot.version ||
          paused.state !== "paused"
        ) {
          throw new ApiFailure("malformed");
        }
        session.accept(paused, "existing", "recovered");
        return;
      } catch (error: unknown) {
        if (!gate.isCurrent(operation)) return;
        const failure = safeFailure(error);
        if (session.loseAccess(failure)) return;
        if (
          failure.code === "GAME_CONFLICT" &&
          failure.currentSnapshot &&
          session.validRevision(failure.currentSnapshot, snapshot.gameId)
        ) {
          snapshot = failure.currentSnapshot;
          store.transition(
            { phase: "recovering", snapshot, pendingCommand: null },
            { notice: store.get().notice },
          );
          if (isTerminal(snapshot) || (snapshot.state === "paused" && !this.context.pausePaused)) {
            session.accept(snapshot, "existing", "recovered");
            return;
          }
          continue;
        }
        const rejection = rejectionOf(failure);
        await session.readBack(operation, rejection);
        return;
      }
    }
    store.transition(
      { snapshot, pendingCommand: null, phase: "recovery-required" },
      { notice: "recovery-required" },
    );
  }
}
