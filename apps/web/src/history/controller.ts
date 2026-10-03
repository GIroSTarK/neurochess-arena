import type { GameHistoryEntry, GameHistoryResponse } from "@neurochess/contracts";

import type { AiApi } from "../api/ai-client";
import { ApiFailure } from "../api/failures";

interface HistoryState {
  readonly result: GameHistoryResponse | null;
  readonly page: number;
  readonly phase: "loading" | "ready" | "error";
  readonly confirmation: GameHistoryEntry | "all" | null;
  readonly deleting: boolean;
  readonly deletionError: "unfinished" | "rejected" | "unconfirmed" | null;
  readonly success: "game" | "history" | null;
}

const initialState: HistoryState = {
  result: null,
  page: 0,
  phase: "loading",
  confirmation: null,
  deleting: false,
  deletionError: null,
  success: null,
};

function deletionError(error: unknown): HistoryState["deletionError"] {
  if (!(error instanceof ApiFailure) || error.kind !== "api" || !error.code) return "unconfirmed";
  if (error.code === "INVALID_GAME_STATE") return "unfinished";
  return error.code === "INTERNAL_SERVER_ERROR" ? "unconfirmed" : "rejected";
}

export class HistoryController {
  private state: HistoryState = initialState;
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private mutation: AbortController | null = null;
  private cursors: (string | undefined)[] = [undefined];
  private targetPage = 0;
  private connected = false;

  constructor(
    private readonly api: Pick<AiApi, "history" | "deleteGame" | "clearHistory">,
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
    this.mutation?.abort();
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
  readonly confirmGame = (game: GameHistoryEntry) => {
    if (this.state.deleting || this.state.phase === "loading") return;
    this.publish({ ...this.state, confirmation: game, deletionError: null, success: null });
  };
  readonly confirmClear = () => {
    if (this.state.deleting || this.state.phase === "loading") return;
    this.publish({ ...this.state, confirmation: "all", deletionError: null, success: null });
  };
  readonly cancelDeletion = () => {
    if (!this.state.deleting) {
      this.publish({ ...this.state, confirmation: null, deletionError: null });
    }
  };
  readonly deleteConfirmed = async () => {
    const confirmation = this.state.confirmation;
    if (!confirmation || this.state.deleting || !this.connected || this.identitySignal.aborted) {
      return;
    }
    this.request?.abort();
    const request = new AbortController();
    this.mutation = request;
    const current = () => this.connected && !request.signal.aborted && !this.identitySignal.aborted;
    this.publish({
      ...this.state,
      phase: this.state.result ? "ready" : "error",
      deleting: true,
      deletionError: null,
    });
    try {
      if (confirmation === "all") await this.api.clearHistory(request.signal);
      else await this.api.deleteGame(confirmation.gameId, request.signal);
      if (!current()) return;
      this.cursors = [undefined];
      this.targetPage = 0;
      // Discard every old page before refresh; a failed read must never resurrect deleted rows.
      this.publish({ ...initialState, success: confirmation === "all" ? "history" : "game" });
      await this.load(0, true);
    } catch (error) {
      if (!current()) return;
      this.publish({
        ...this.state,
        deleting: false,
        deletionError: deletionError(error),
      });
    }
  };
  private async load(page: number, preserveSuccess = false) {
    if (!this.connected || this.identitySignal.aborted || this.state.deleting) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.targetPage = page;
    this.publish({
      ...this.state,
      phase: "loading",
      success: preserveSuccess ? this.state.success : null,
    });
    const current = () => this.connected && !request.signal.aborted && !this.identitySignal.aborted;
    try {
      const cursor = this.cursors[page];
      const result = await this.api.history(
        { limit: 20, ...(cursor ? { cursor } : {}) },
        request.signal,
      );
      if (current()) {
        this.cursors.length = page + 1;
        this.publish({ ...this.state, result, page, phase: "ready" });
      }
    } catch {
      if (current()) this.publish({ ...this.state, phase: "error" });
    }
  }
}
