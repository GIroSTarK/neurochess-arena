import type { GameSnapshot, LifecycleCommand } from "@neurochess/contracts";

import { ApiFailure, type SandboxApi } from "../api/client";

import { failureNotice, rejectionOf, safeFailure } from "./failures";
import type { SandboxNavigation } from "./navigation";
import type { Operation, OperationGate } from "./operations";
import type { GameSession } from "./session";
import { isTerminal, type SandboxState } from "./state";
import type { Store } from "./store";

export interface RecoveryContext {
  readonly api: Pick<SandboxApi, "snapshot" | "unfinished" | "lifecycle">;
  readonly store: Store<SandboxState>;
  readonly gate: OperationGate;
  readonly commandId: () => string;
  readonly navigation: SandboxNavigation | undefined;
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
    store.patch({ phase: "recovering", notice: null });
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
        store.patch({ phase: "entry", snapshot: null });
      }
    } catch (error: unknown) {
      if (!gate.isCurrent(operation)) return;
      const failure = safeFailure(error);
      if (discovery && failure.code === "UNAUTHORIZED") {
        session.endRecovery();
        store.patch({ phase: "entry", snapshot: null, notice: null });
      } else if (discovery && failure.code === "NOT_FOUND") {
        session.endRecovery();
        store.patch({ phase: "unavailable", notice: "sandbox-unavailable" });
      } else if (!session.loseAccess(failure)) {
        store.patch({ phase: "recovery-required", notice: failureNotice(failure) });
      }
    } finally {
      gate.finish(operation);
    }
  }

  /** Adopts a recovered snapshot and pauses it if it is still active. */
  async pauseRecovered(operation: Operation, initial: GameSnapshot): Promise<void> {
    const { api, store, gate, navigation, session } = this.context;
    session.beginRecovery();
    navigation?.open(initial.gameId, true);
    let snapshot = initial;
    for (let attempt = 0; attempt < PAUSE_ATTEMPTS; attempt += 1) {
      if (!gate.isCurrent(operation)) return;
      store.patch({
        snapshot,
        pendingCommand: null,
        phase: "recovering",
        interactionRevision: store.get().interactionRevision + 1,
      });
      if (snapshot.state !== "active") {
        if (snapshot.state !== "paused" && !isTerminal(snapshot)) throw new ApiFailure("malformed");
        session.accept(snapshot, "existing", "existing");
        return;
      }
      const command: LifecycleCommand = {
        action: "pause",
        gameId: snapshot.gameId,
        expectedVersion: snapshot.version,
        commandId: this.context.commandId(),
      };
      store.patch({ pendingCommand: command });
      try {
        const paused = await api.lifecycle(command, operation.abort.signal);
        if (!gate.isCurrent(operation)) return;
        if (
          !session.validRevision(paused, snapshot.gameId) ||
          paused.version <= snapshot.version ||
          paused.state !== "paused"
        )
          throw new ApiFailure("malformed");
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
          store.patch({ snapshot, pendingCommand: null });
          if (snapshot.state !== "active") {
            session.accept(snapshot, "existing", "recovered");
            return;
          }
          continue;
        }
        const rejection = rejectionOf(failure);
        if (rejection) store.patch({ pendingCommand: null });
        await session.readBack(operation, rejection);
        return;
      }
    }
    store.patch({
      snapshot,
      pendingCommand: null,
      phase: "recovery-required",
      notice: "recovery-required",
    });
  }
}
