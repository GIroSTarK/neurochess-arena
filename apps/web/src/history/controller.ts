import type { GameHistoryResponse } from "@neurochess/contracts";

import type { AiApi } from "../api/ai-client";

interface HistoryState {
  readonly result: GameHistoryResponse | null;
  readonly page: number;
  readonly phase: "loading" | "ready" | "error";
}

export class HistoryController {
  private state: HistoryState = { result: null, page: 0, phase: "loading" };
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private cursors: (string | undefined)[] = [undefined];
  private targetPage = 0;
  private connected = false;

  constructor(
    private readonly api: Pick<AiApi, "history">,
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
    this.cursors = [undefined];
    this.targetPage = 0;
    this.publish({ result: null, page: 0, phase: "loading" });
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
  private async load(page: number) {
    if (!this.connected || this.identitySignal.aborted) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.targetPage = page;
    this.publish({ ...this.state, phase: "loading" });
    const current = () => this.connected && !request.signal.aborted && !this.identitySignal.aborted;
    try {
      const cursor = this.cursors[page];
      const result = await this.api.history(
        { limit: 20, ...(cursor ? { cursor } : {}) },
        request.signal,
      );
      if (current()) {
        this.cursors.length = page + 1;
        this.publish({ result, page, phase: "ready" });
      }
    } catch {
      if (current()) this.publish({ ...this.state, phase: "error" });
    }
  }
}
