import { createGame } from "@neurochess/chess";
import type { AnalysisSample, GameSnapshot, StoredAnalysisSample } from "@neurochess/contracts";

import { PROFILE_ID } from "../analysis/protocol";
import {
  type AnalysisHistory,
  AnalysisScheduler,
  type PlyState,
  type RetainedSample,
} from "../analysis/scheduler";
import { type AnalysisApi, AnalysisProfileObsolete } from "../api/analysis-client";
import { ApiFailure } from "../api/failures";

import { isAccessFailure } from "./failures";

export interface EvaluationPly extends PlyState {
  readonly saved: "memory" | "saved" | "unsaved";
}
export interface EvaluationView {
  readonly gameId: string | null;
  readonly plies: readonly EvaluationPly[];
  readonly persistence: "memory" | "loading" | "ready" | "error" | "obsolete";
  readonly suspended: boolean;
  readonly accessError: boolean;
}
export const emptyEvaluation: EvaluationView = {
  gameId: null,
  plies: [],
  persistence: "memory",
  suspended: false,
  accessError: false,
};

function scalar(sample: RetainedSample): AnalysisSample {
  return {
    ply: sample.ply,
    fen: sample.fen,
    historyDigest: sample.historyDigest,
    profileId: sample.profileId,
    depth: sample.depth,
    durationMs: sample.durationMs,
    score: sample.score,
  };
}
function signature(sample: RetainedSample): string {
  return JSON.stringify(scalar(sample));
}

export class GameAnalysisController {
  private snapshot: GameSnapshot | null;
  private readonly lifetime = crypto.randomUUID();
  private readonly scheduler: AnalysisScheduler;
  private readonly listeners = new Set<() => void>();
  private readonly saved = new Map<number, string>();
  private unsubscribe: () => void;
  private io = new AbortController();
  private epoch = 0;
  private selected: number;
  private started = false;
  private hidden = false;
  private reading = false;
  private uploading = false;
  private resuming = false;
  private accessError = false;
  private persistence: EvaluationView["persistence"];
  private view: EvaluationView = emptyEvaluation;

  constructor(
    snapshot: GameSnapshot,
    private readonly api?: AnalysisApi,
    createScheduler: (history: AnalysisHistory) => AnalysisScheduler = (history) =>
      new AnalysisScheduler(history),
  ) {
    this.snapshot = snapshot;
    this.selected = snapshot.moves.length;
    this.persistence = api ? "loading" : "memory";
    this.scheduler = createScheduler(this.history(snapshot));
    this.unsubscribe = this.scheduler.subscribe(() => {
      this.publish();
      void this.flush();
    });
    this.publish();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.view;

  start() {
    if (this.started || !this.snapshot) return;
    this.started = true;
    if (this.hidden) return;
    if (this.api) void this.read();
    else this.scheduler.show(this.selected);
  }

  update(snapshot: GameSnapshot, selected: number) {
    if (!this.snapshot) return;
    if (
      snapshot.gameId !== this.snapshot.gameId ||
      snapshot.moves.length < this.snapshot.moves.length ||
      this.snapshot.moves.some(
        (move, index) =>
          move.uci !== snapshot.moves[index]?.uci || move.fen !== snapshot.moves[index].fen,
      )
    ) {
      this.dispose();
      return;
    }
    this.snapshot = snapshot;
    this.selected = Math.max(0, Math.min(snapshot.moves.length, selected));
    this.scheduler.updateHistory(this.history(snapshot));
    if (this.started && !this.reading) this.scheduler.show(this.selected);
    this.publish();
  }

  suspend() {
    if (!this.snapshot) return;
    if (this.uploading) this.persistence = "error";
    this.hidden = true;
    this.cancelIo();
    this.scheduler.suspend();
    this.publish();
  }

  async resume(authorize: (signal: AbortSignal) => Promise<boolean>) {
    if (!this.snapshot || !this.hidden || this.resuming) return;
    this.resuming = true;
    const epoch = this.epoch;
    try {
      const allowed = await authorize(this.io.signal);
      if (!this.current(epoch)) return;
      if (!allowed) {
        this.dispose();
        return;
      }
      this.accessError = false;
      this.hidden = false;
      if (this.persistence === "obsolete") return;
      this.reading = Boolean(this.api);
      await this.scheduler.resume(async () => true);
      if (!this.current(epoch)) return;
      this.reading = false;
      if (this.api) await this.read();
      else this.scheduler.show(this.selected);
    } catch (error) {
      if (!this.current(epoch)) return;
      if (isAccessFailure(error)) this.dispose();
      else {
        this.accessError = true;
        this.publish();
      }
    } finally {
      if (this.current(epoch)) {
        this.resuming = false;
        this.publish();
      }
    }
  }

  retry(ply: number) {
    if (!this.snapshot || this.hidden || this.persistence === "obsolete") return;
    this.scheduler.retry(ply);
  }

  retryPersistence() {
    if (
      !this.snapshot ||
      this.hidden ||
      this.persistence !== "error" ||
      this.reading ||
      this.uploading
    ) {
      return;
    }
    this.persistence = "loading";
    void this.read();
  }

  dispose() {
    if (!this.snapshot) return;
    this.snapshot = null;
    this.cancelIo();
    this.unsubscribe();
    this.scheduler.dispose();
    this.saved.clear();
    this.view = emptyEvaluation;
    this.listeners.forEach((listener) => listener());
  }

  private history(snapshot: GameSnapshot): AnalysisHistory {
    return {
      lifetime: this.lifetime,
      gameId: snapshot.gameId,
      initialFen: createGame().snapshot().fen,
      moves: snapshot.moves,
    };
  }
  private current(epoch: number) {
    return this.snapshot !== null && epoch === this.epoch;
  }
  private cancelIo() {
    this.epoch++;
    this.io.abort();
    this.io = new AbortController();
    this.reading = false;
    this.uploading = false;
    this.resuming = false;
  }

  private async retain(samples: readonly StoredAnalysisSample[], epoch: number) {
    const game = this.snapshot;
    if (!game || !this.current(epoch) || this.hidden) return;
    if (samples.some((sample) => sample.ply > game.moves.length)) throw new ApiFailure("malformed");
    const seeded = samples.map((sample) => ({
      ...sample,
      lifetime: this.lifetime,
      gameId: game.gameId,
      generation: 1,
    }));
    await this.scheduler.seed(seeded, true);
    if (!this.current(epoch)) return;
    for (const sample of seeded) this.saved.set(sample.ply, signature(sample));
  }

  private async read() {
    const game = this.snapshot;
    if (!game || !this.api || this.hidden || this.reading || this.persistence === "obsolete") {
      return;
    }
    const epoch = this.epoch;
    const blocked = this.persistence === "error";
    this.reading = true;
    this.publish();
    try {
      let cursor: string | undefined;
      do {
        const page = await this.api.read(game.gameId, cursor, this.io.signal);
        if (!this.current(epoch)) return;
        await this.retain(page.samples, epoch);
        if (!this.current(epoch)) return;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (!blocked) this.persistence = "ready";
    } catch (error) {
      if (!this.current(epoch)) return;
      if (isAccessFailure(error)) {
        this.dispose();
        return;
      }
      this.persistence = "error";
    } finally {
      if (this.current(epoch)) {
        this.reading = false;
        this.scheduler.show(this.selected);
        this.publish();
        void this.flush();
      }
    }
  }

  private async flush() {
    const game = this.snapshot;
    if (
      !game ||
      !this.api ||
      this.hidden ||
      this.reading ||
      this.uploading ||
      this.persistence !== "ready"
    ) {
      return;
    }
    const batch: AnalysisSample[] = [];
    for (let ply = 0; ply <= game.moves.length && batch.length < 32; ply++) {
      const sample = this.scheduler.getState(ply).sample;
      if (sample?.profileId === PROFILE_ID && this.saved.get(ply) !== signature(sample)) {
        batch.push(scalar(sample));
      }
    }
    if (batch.length === 0) return;
    const epoch = this.epoch;
    this.uploading = true;
    try {
      const result = await this.api.write(game.gameId, batch, this.io.signal);
      if (!this.current(epoch)) return;
      await this.retain(result.samples, epoch);
    } catch (error) {
      if (!this.current(epoch)) return;
      if (isAccessFailure(error)) {
        this.dispose();
        return;
      }
      this.persistence = error instanceof AnalysisProfileObsolete ? "obsolete" : "error";
      if (this.persistence === "obsolete") this.scheduler.suspend();
    } finally {
      if (this.current(epoch)) {
        this.uploading = false;
        this.publish();
        void this.flush();
      }
    }
  }

  private publish() {
    if (!this.snapshot) return;
    this.view = {
      gameId: this.snapshot.gameId,
      plies: Array.from({ length: this.snapshot.moves.length + 1 }, (_, ply) => {
        const state = this.scheduler.getState(ply);
        return {
          ...state,
          saved: !this.api
            ? "memory"
            : state.sample && this.saved.get(ply) === signature(state.sample)
              ? "saved"
              : "unsaved",
        };
      }),
      persistence: this.persistence,
      suspended: this.hidden,
      accessError: this.accessError,
    };
    this.listeners.forEach((listener) => listener());
  }
}
