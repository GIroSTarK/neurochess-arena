import type { GameHistoryEntry, GameHistoryResponse } from "@neurochess/contracts";

import type { AiApi } from "../api/ai-client";
import { ApiFailure } from "../api/failures";

type HistoryDeletionTarget = GameHistoryEntry | "all";
type HistoryDeletionError = "uncertain" | "unfinished" | "rejected";

interface HistoryDeletion {
  readonly target: HistoryDeletionTarget;
  readonly pending: boolean;
  readonly error: HistoryDeletionError | null;
}

interface HistoryState {
  readonly result: GameHistoryResponse | null;
  readonly page: number;
  readonly phase: "loading" | "ready" | "error";
  readonly deletion: HistoryDeletion | null;
  readonly notice: "deleted" | "cleared" | null;
}

const initialState: HistoryState = {
  result: null,
  page: 0,
  phase: "loading",
  deletion: null,
  notice: null,
};

function deletionError(error: unknown): HistoryDeletionError {
  if (error instanceof ApiFailure && error.kind === "api") {
    if (error.code === "INVALID_GAME_STATE") return "unfinished";
    if (error.code !== "INTERNAL_SERVER_ERROR") return "rejected";
  }
  // Transport, timeout, malformed and server failures can follow a committed deletion.
  return "uncertain";
}

export class HistoryController {
  private state: HistoryState = initialState;
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private deletionRequest: AbortController | null = null;
  private cursors: (string | undefined)[] = [undefined];
  private targetPage = 0;
  private connected = false;

  constructor(
    private readonly api: Pick<AiApi, "history" | "deleteHistoryGame" | "clearHistory">,
    private readonly identitySignal: AbortSignal,
  ) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: HistoryState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private readonly clear = () => {
    this.request?.abort();
    this.deletionRequest?.abort();
    this.cursors = [undefined];
    this.targetPage = 0;
    this.publish(initialState);
  };
  connect() {
    this.connected = true;
    window.addEventListener("pagehide", this.clear);
    window.addEventListener("pageshow", this.reload);
    this.identitySignal.addEventListener("abort", this.clear);
    this.reload();
    return () => {
      this.connected = false;
      window.removeEventListener("pagehide", this.clear);
      window.removeEventListener("pageshow", this.reload);
      this.identitySignal.removeEventListener("abort", this.clear);
      this.clear();
    };
  }
  readonly reload = () => {
    void this.load(0);
  };
  readonly retry = () => {
    void this.load(this.targetPage);
  };
  readonly older = () => {
    if (this.state.phase === "loading" || !this.state.result?.nextCursor) return;
    this.cursors[this.state.page + 1] = this.state.result.nextCursor;
    void this.load(this.state.page + 1);
  };
  readonly newer = () => {
    if (this.state.phase !== "loading" && this.state.page > 0) void this.load(this.state.page - 1);
  };
  readonly requestDeletion = (target: HistoryDeletionTarget) => {
    if (this.state.deletion?.pending) return;
    this.publish({
      ...this.state,
      deletion: { target, pending: false, error: null },
      notice: null,
    });
  };
  readonly cancelDeletion = () => {
    const { deletion } = this.state;
    if (!deletion || deletion.pending) return;
    this.publish({ ...this.state, deletion: null });
    // An unconfirmed attempt may still have committed; show the authoritative list.
    if (deletion.error) void this.load(this.state.page);
  };
  readonly confirmDeletion = async () => {
    const { deletion } = this.state;
    if (!deletion || deletion.pending || !this.connected || this.identitySignal.aborted) return;
    const request = new AbortController();
    this.deletionRequest = request;
    this.publish({ ...this.state, deletion: { ...deletion, pending: true, error: null } });
    const current = () => this.connected && !request.signal.aborted && !this.identitySignal.aborted;
    try {
      if (deletion.target === "all") await this.api.clearHistory(request.signal);
      else await this.api.deleteHistoryGame(deletion.target.gameId, request.signal);
    } catch (error) {
      if (current()) {
        this.publish({
          ...this.state,
          deletion: { ...deletion, pending: false, error: deletionError(error) },
        });
      }
      return;
    }
    if (!current()) return;
    // The server confirmed these removals, so they stay hidden even if the reload fails.
    const { target } = deletion;
    if (target === "all") {
      this.cursors = [undefined];
      this.publish({
        ...this.state,
        deletion: null,
        result: { games: [], nextCursor: null },
        page: 0,
      });
      await this.load(0, "cleared");
    } else {
      const { result } = this.state;
      this.publish({
        ...this.state,
        deletion: null,
        result: result && {
          ...result,
          games: result.games.filter((game) => game.gameId !== target.gameId),
        },
      });
      await this.load(this.state.page, "deleted");
    }
  };
  private async load(page: number, notice: HistoryState["notice"] = null) {
    if (!this.connected || this.identitySignal.aborted) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.targetPage = page;
    this.publish({ ...this.state, phase: "loading", notice });
    const current = () => this.connected && !request.signal.aborted && !this.identitySignal.aborted;
    try {
      const cursor = this.cursors[page];
      const result = await this.api.history(
        { limit: 20, ...(cursor ? { cursor } : {}) },
        request.signal,
      );
      if (!current()) return;
      // Deletions here or in another tab can empty a later page; show the nearest results.
      if (page > 0 && result.games.length === 0) {
        await this.load(page - 1, notice);
        return;
      }
      this.cursors.length = page + 1;
      this.publish({ ...this.state, result, page, phase: "ready" });
    } catch {
      if (current()) this.publish({ ...this.state, phase: "error" });
    }
  }
}
