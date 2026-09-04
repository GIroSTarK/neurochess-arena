import type { GameSnapshot } from "@neurochess/contracts";

import { ApiFailure, type SandboxApi } from "../api/client";

import { failureNotice, safeFailure } from "./failures";
import type { PgnDelivery } from "./pgn";
import { emptyExport, emptyReplay, isTerminal, sameSnapshot } from "./state";
import type { SandboxStore } from "./store";

export interface ArchiveContext {
  readonly api: Pick<SandboxApi, "replay" | "pgn">;
  readonly delivery: PgnDelivery;
  readonly store: SandboxStore;
  readonly isConnected: () => boolean;
  /** Clears the loaded game on an access failure and reports whether it was one. */
  readonly loseAccess: (failure: ApiFailure) => boolean;
}

type ArchiveSlot = "replay" | "export";

interface ArchiveRequest {
  readonly snapshot: GameSnapshot;
  readonly signal: AbortSignal;
  /** True while the same terminal snapshot revision is still loaded and connected. */
  readonly current: () => boolean;
  readonly release: () => void;
}

/**
 * Private replay and PGN export for a terminal game. These reads never change the accepted
 * snapshot, and a response is applied only while the snapshot it was requested for is loaded.
 */
export class ArchiveController {
  private readonly requests: Record<ArchiveSlot, AbortController | null> = {
    replay: null,
    export: null,
  };

  constructor(private readonly context: ArchiveContext) {}

  async loadReplay(): Promise<void> {
    const request = this.begin("replay");
    if (!request) return;
    const { snapshot, signal, current, release } = request;
    const { api, store } = this.context;
    const previous = store.get();
    store.setReplay({
      ...(previous.replay
        ? { replay: previous.replay, replayPly: previous.replayPly }
        : emptyReplay),
      replayPhase: "loading",
      replayNotice: null,
    });
    try {
      const replay = await api.replay(snapshot.gameId, signal);
      if (!current()) return;
      if (!sameSnapshot(replay.snapshot, snapshot)) throw new ApiFailure("malformed");
      store.setReplay({
        replay,
        replayPly: snapshot.moves.length,
        replayPhase: "idle",
        replayNotice: null,
      });
    } catch (error: unknown) {
      if (!current()) return;
      const failure = safeFailure(error);
      if (!this.context.loseAccess(failure)) {
        const retained = store.get();
        store.setReplay({
          ...(retained.replay
            ? { replay: retained.replay, replayPly: retained.replayPly }
            : emptyReplay),
          replayPhase: "error",
          replayNotice: failureNotice(failure),
        });
      }
    } finally {
      release();
    }
  }

  /** Moves the replay cursor; the accepted snapshot is never modified. */
  selectPly(ply: number): void {
    const { store } = this.context;
    const state = store.get();
    const { replay } = state;
    if (!replay || !Number.isInteger(ply) || ply < 0 || ply > replay.snapshot.moves.length) return;
    const status =
      state.replayPhase === "error"
        ? { replayPhase: state.replayPhase, replayNotice: state.replayNotice }
        : { replayPhase: state.replayPhase, replayNotice: null };
    store.setReplay(
      { replay, replayPly: ply, ...status },
      {
        invalidateInteraction: true,
        announcement: { kind: "replay", ply, san: replay.snapshot.moves[ply - 1]?.san ?? null },
      },
    );
  }

  async exportPgn(action: "copy" | "download"): Promise<void> {
    const request = this.begin("export");
    if (!request) return;
    const { snapshot, signal, current, release } = request;
    const { api, delivery, store } = this.context;
    store.setExport({ exportPhase: "loading", exportText: null, exportNotice: null });
    try {
      const response = await api.pgn(snapshot.gameId, signal);
      if (!current()) return;
      if (
        response.gameId !== snapshot.gameId ||
        response.version !== snapshot.version ||
        response.pgn !== snapshot.pgn
      ) {
        throw new ApiFailure("malformed");
      }
      let outcome: "copied" | "downloaded" | "manual";
      if (action === "copy") outcome = (await delivery.copy(response.pgn)) ? "copied" : "manual";
      else {
        delivery.download(response.pgn, snapshot.gameId);
        outcome = "downloaded";
      }
      if (!current()) return;
      store.setExport(
        outcome === "manual"
          ? { exportPhase: "manual", exportText: response.pgn, exportNotice: null }
          : { exportPhase: outcome, exportText: null, exportNotice: null },
        {
          announcement: {
            kind: "notice",
            notice:
              outcome === "copied"
                ? "pgn-copied"
                : outcome === "manual"
                  ? "pgn-manual"
                  : "pgn-downloaded",
          },
        },
      );
    } catch (error: unknown) {
      if (!current()) return;
      const failure = safeFailure(error);
      if (!this.context.loseAccess(failure)) {
        store.setExport({
          exportPhase: "error",
          exportText: null,
          exportNotice: failureNotice(failure),
        });
      }
    } finally {
      release();
    }
  }

  /** Aborts in-flight archive requests and makes interrupted exports retryable. */
  cancel(): void {
    for (const slot of ["replay", "export"] as const) {
      this.requests[slot]?.abort();
      this.requests[slot] = null;
    }
    if (this.context.store.get().exportPhase === "loading") {
      this.context.store.setExport(emptyExport);
    }
  }

  /** One request per slot, bound to the terminal snapshot loaded right now. */
  private begin(slot: ArchiveSlot): ArchiveRequest | null {
    const { store, isConnected } = this.context;
    const snapshot = store.get().snapshot;
    if (!isConnected() || !snapshot || !isTerminal(snapshot) || this.requests[slot]) return null;
    const abort = new AbortController();
    this.requests[slot] = abort;
    return {
      snapshot,
      signal: abort.signal,
      current: () => {
        const loaded = store.get().snapshot;
        return (
          isConnected() &&
          this.requests[slot] === abort &&
          loaded?.gameId === snapshot.gameId &&
          loaded.version === snapshot.version
        );
      },
      release: () => {
        if (this.requests[slot] === abort) this.requests[slot] = null;
      },
    };
  }
}
