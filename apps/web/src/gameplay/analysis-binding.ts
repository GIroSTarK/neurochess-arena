import type { GameSnapshot } from "@neurochess/contracts";

import { bindAnalysisLifetime } from "../analysis/browser-lifetime";
import type { AnalysisApi } from "../api/analysis-client";

import {
  emptyEvaluation,
  type EvaluationView,
  GameAnalysisController,
} from "./analysis-controller";

export interface AnalysisPosition {
  readonly snapshot: GameSnapshot;
  readonly ply: number;
}
export interface AnalysisSource<State> {
  getSnapshot(): State;
  subscribe(listener: () => void): () => void;
}

export class AnalysisBinding<State> {
  private controller: GameAnalysisController | null = null;
  private gameId: string | null = null;
  private view: EvaluationView = emptyEvaluation;
  private readonly listeners = new Set<() => void>();
  private closeGame = () => undefined as void;

  constructor(
    private readonly source: AnalysisSource<State>,
    private readonly select: (state: State) => AnalysisPosition | null,
    private readonly options: {
      readonly api?: AnalysisApi | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly authorize: (gameId: string, signal: AbortSignal) => Promise<void>;
    },
  ) {}
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.view;
  readonly retry = (ply: number) => {
    if (this.view.accessError) void this.controller?.resume((signal) => this.authorize(signal));
    else this.controller?.retry(ply);
  };
  readonly retryPersistence = () => this.controller?.retryPersistence();

  connect() {
    const lifetime = new AbortController();
    const sync = () => {
      if (lifetime.signal.aborted) return;
      const position = this.select(this.source.getSnapshot());
      if (position?.snapshot.gameId !== this.gameId) {
        this.closeGame();
        this.controller = null;
        this.gameId = position?.snapshot.gameId ?? null;
        this.publish(emptyEvaluation);
        if (position) {
          const controller = new GameAnalysisController(position.snapshot, this.options.api);
          this.controller = controller;
          const unsubscribe = controller.subscribe(() => this.publish(controller.getSnapshot()));
          const unbind = bindAnalysisLifetime(controller, {
            signal: lifetime.signal,
            reauthorize: (signal) => this.authorize(signal),
          });
          this.closeGame = () => {
            unsubscribe();
            unbind();
          };
          controller.update(position.snapshot, position.ply);
          controller.start();
        }
      } else this.controller?.update(position.snapshot, position.ply);
    };
    const unsubscribe = this.source.subscribe(sync);
    const end = () => {
      lifetime.abort();
      unsubscribe();
      this.closeGame();
      this.controller = null;
      this.gameId = null;
      this.publish(emptyEvaluation);
      this.options.signal?.removeEventListener("abort", end);
      window.removeEventListener("pagehide", end);
    };
    this.options.signal?.addEventListener("abort", end, { once: true });
    window.addEventListener("pagehide", end, { once: true });
    if (this.options.signal?.aborted) end();
    else sync();
    return end;
  }

  private async authorize(signal: AbortSignal) {
    if (!this.gameId) return false;
    await this.options.authorize(this.gameId, signal);
    return true;
  }
  private publish(view: EvaluationView) {
    this.view = view;
    this.listeners.forEach((listener) => listener());
  }
}
