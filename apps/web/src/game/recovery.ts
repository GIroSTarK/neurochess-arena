import type { GameSnapshot, LifecycleCommand } from "@neurochess/contracts";

import { ApiFailure, type SandboxApi } from "../api/client";
import type { GameTarget } from "../app/navigation";
import { parseGameId } from "../app/route-urls";

import { failureNotice, rejectionOf, safeFailure } from "./failures";
import type { Operation, OperationGate } from "./operations";
import type { GameSession } from "./session";
import { isTerminal } from "./state";
import type { SandboxStore } from "./store";

export interface RecoveryContext {
  readonly api: Pick<SandboxApi, "snapshot" | "lifecycle">;
  readonly store: SandboxStore;
  readonly gate: OperationGate;
  readonly commandId: () => string;
  readonly onGame: (gameId: string) => void;
  readonly session: Pick<
    GameSession,
    "accept" | "loseAccess" | "readBack" | "validRevision" | "beginRecovery" | "endRecovery"
  >;
}

/** Concurrent active snapshots are reconciled with at most this many pause attempts. */
const PAUSE_ATTEMPTS = 3;

/**
 * Adopts loader entry data, or re-reads a known game for explicit command recovery, then pauses
 * through a versioned command. No recovered active snapshot enables play.
 */
export class RecoveryController {
  constructor(private readonly context: RecoveryContext) {}

  async recover(target: GameTarget, entrySnapshot?: GameSnapshot | null): Promise<void> {
    const { api, store, gate, session } = this.context;
    if (store.get().pendingCommand) return;
    const operation = gate.begin();
    if (!operation) return;
    const gameId =
      target.kind === "game"
        ? parseGameId(target.gameId)
        : target.kind === "none"
          ? (store.get().snapshot?.gameId ?? null)
          : null;
    session.beginRecovery();
    store.transition(
      { phase: "recovering", snapshot: store.get().snapshot, pendingCommand: null },
      { notice: null },
    );
    try {
      if (target.kind === "invalid" || (target.kind === "game" && !gameId)) {
        throw new ApiFailure("api", "NOT_FOUND");
      }
      // Seeded entries also yield so a discarded mount cannot begin recovery writes.
      const snapshot = await (entrySnapshot !== undefined
        ? entrySnapshot
        : gameId
          ? api.snapshot(gameId, operation.abort.signal)
          : null);
      if (!gate.isCurrent(operation)) return;
      if (gameId && !snapshot) throw new ApiFailure("malformed");
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
      if (!session.loseAccess(failure)) {
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
    const { api, store, gate, onGame, session } = this.context;
    session.beginRecovery();
    onGame(initial.gameId);
    let snapshot = initial;
    for (let attempt = 0; attempt < PAUSE_ATTEMPTS; attempt += 1) {
      if (!gate.isCurrent(operation)) return;
      store.transition(
        { snapshot, pendingCommand: null, phase: "recovering" },
        { notice: store.get().notice, invalidateInteraction: true },
      );
      if (snapshot.state !== "active") {
        if (snapshot.state !== "paused" && !isTerminal(snapshot)) throw new ApiFailure("malformed");
        session.accept(snapshot, "existing", isTerminal(snapshot) ? null : "existing");
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
          if (snapshot.state !== "active") {
            session.accept(snapshot, "existing", isTerminal(snapshot) ? null : "recovered");
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
