import type { ReplayedPosition } from "@neurochess/chess";
import { z } from "zod";

import {
  type AnalysisSample,
  type AnalysisScore,
  historyDigest,
  PROFILE_ID,
  type UnavailableReason,
  visitPositions,
} from "./protocol";
import { AnalysisWorkerClient, type SearchOutcome } from "./worker-client";

const historySchema = z.object({
  lifetime: z.string().min(1).max(128),
  gameId: z.uuid(),
  initialFen: z.string().min(1).max(128),
  moves: z.array(
    z.object({
      uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
      fen: z.string().min(1).max(128),
    }),
  ),
});
export interface AnalysisHistory {
  readonly lifetime: string;
  readonly gameId: string;
  readonly initialFen: string;
  readonly moves: readonly { readonly uci: string; readonly fen: string }[];
}
export type RetainedSample = Omit<AnalysisSample, "profileId"> & { readonly profileId: string };
export interface PlyState {
  readonly status: "pending" | "computing" | "suspended" | "ready" | "unavailable";
  readonly sample?: RetainedSample;
  readonly reason?: UnavailableReason | undefined;
}
type WorkerDriver = Pick<
  AnalysisWorkerClient,
  "analyze" | "cancel" | "suspend" | "retry" | "dispose"
>;
interface Dispatch {
  readonly ply: number;
  readonly historical: boolean;
  cancelled: boolean;
}

const scoreSchema: z.ZodType<AnalysisScore> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cp"), value: z.int().min(-100000).max(100000) }),
  z.strictObject({
    kind: z.literal("mate"),
    winner: z.enum(["white", "black"]),
    moves: z.int().min(0).max(128),
  }),
]);
const seedSchema = z
  .array(
    z.object({
      lifetime: z.string(),
      gameId: z.uuid(),
      generation: z.int().positive(),
      ply: z.int().nonnegative(),
      fen: z.string().max(128),
      historyDigest: z.string().regex(/^[0-9a-f]{64}$/),
      profileId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
      depth: z.int().min(0).max(18),
      durationMs: z.int().min(0).max(3000),
      score: scoreSchema,
    }),
  )
  .max(128);

export class AnalysisScheduler {
  private history: AnalysisHistory | null;
  private readonly states = new Map<number, PlyState>();
  private readonly listeners = new Set<() => void>();
  private foreground: number | undefined;
  private foregroundDispatches = 0;
  private active: Dispatch | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastCompleted = -Infinity;
  private hidden = false;
  private fault = false;
  private epoch = 0;
  private authorization: AbortController | undefined;
  private validation = new AbortController();

  constructor(
    history: AnalysisHistory,
    private readonly worker: WorkerDriver = new AnalysisWorkerClient(),
  ) {
    const parsed = historySchema.safeParse(history);
    if (!parsed.success) throw new Error("engine_protocol_error");
    this.history = parsed.data;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState(ply: number): PlyState {
    if (!this.history) return { status: "suspended" };
    const state = this.states.get(ply);
    if (state?.status === "ready" || state?.status === "unavailable") return state;
    return {
      ...state,
      status: this.hidden || this.fault ? "suspended" : (state?.status ?? "pending"),
    };
  }

  show(ply: number): void {
    if (!this.history || !Number.isInteger(ply) || ply < 0 || ply > this.history.moves.length) {
      return;
    }
    this.foreground = ply;
    if (this.active && !this.active.historical && this.active.ply !== ply) {
      this.active.cancelled = true;
      this.worker.cancel();
    }
    this.schedule();
  }

  updateHistory(input: AnalysisHistory): void {
    if (!this.history) return;
    const parsed = historySchema.safeParse(input);
    const previous = this.history;
    if (
      !parsed.success ||
      parsed.data.lifetime !== previous.lifetime ||
      parsed.data.gameId !== previous.gameId ||
      parsed.data.initialFen !== previous.initialFen ||
      parsed.data.moves.length < previous.moves.length ||
      previous.moves.some((move, index) => {
        const next = parsed.data.moves[index];
        return move.uci !== next?.uci || move.fen !== next.fen;
      })
    ) {
      this.dispose();
      return;
    }
    this.history = parsed.data;
    this.schedule();
  }

  async seed(input: unknown): Promise<void> {
    const parsed = seedSchema.safeParse(input);
    const history = this.history;
    const epoch = this.epoch;
    if (!parsed.success || !history || this.hidden) return;
    const wanted = new Set(
      parsed.data
        .filter((sample) => sample.ply <= history.moves.length)
        .map((sample) => sample.ply),
    );
    if (wanted.size === 0) return;
    const positions = new Map<number, ReplayedPosition>();
    try {
      await visitPositions(
        history.moves.slice(0, Math.max(...wanted)).map((move) => move.uci),
        (position) => {
          if (wanted.has(position.ply)) positions.set(position.ply, position);
        },
        this.validation.signal,
      );
    } catch {
      return;
    }
    if (this.epoch !== epoch) return;
    for (const sample of parsed.data) {
      if (
        sample.lifetime !== history.lifetime ||
        sample.gameId !== history.gameId ||
        sample.ply > history.moves.length ||
        sample.fen !== this.fen(sample.ply)
      ) {
        continue;
      }
      const digest = await historyDigest(
        history.moves.slice(0, sample.ply).map((move) => move.uci),
      );
      if (this.epoch !== epoch) return;
      if (sample.historyDigest !== digest) continue;
      const position = positions.get(sample.ply);
      if (sample.fen !== position?.fen) continue;
      if (
        sample.score.kind === "mate" &&
        sample.score.moves === 0 &&
        (position.terminationReason !== "checkmate" || sample.score.winner === position.turn)
      ) {
        continue;
      }
      const existing = this.states.get(sample.ply);
      if (
        existing?.sample?.profileId === PROFILE_ID &&
        (sample.profileId !== PROFILE_ID || existing.sample.depth >= sample.depth)
      ) {
        continue;
      }
      this.setState(sample.ply, {
        status: sample.profileId === PROFILE_ID ? "ready" : "pending",
        sample,
      });
    }
    this.publish();
    this.schedule();
  }

  suspend(): void {
    if (!this.history) return;
    this.hidden = true;
    this.epoch++;
    this.validation.abort();
    this.validation = new AbortController();
    this.authorization?.abort();
    this.authorization = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.active) {
      this.setState(this.active.ply, { ...this.states.get(this.active.ply), status: "pending" });
    }
    this.active = undefined;
    this.worker.suspend();
    this.publish();
  }

  async resume(authorize: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
    if (!this.history || !this.hidden || this.authorization) return;
    const authorization = new AbortController();
    this.authorization = authorization;
    const epoch = this.epoch;
    try {
      const allowed = await authorize(authorization.signal);
      if (authorization.signal.aborted || epoch !== this.epoch) return;
      if (!allowed) {
        this.dispose();
        return;
      }
      this.hidden = false;
      this.publish();
      this.schedule();
    } catch {
      // An uncertain access refresh leaves computation suspended. The caller may
      // explicitly refresh again; no private result or worker is revived here.
    } finally {
      if (this.authorization === authorization) this.authorization = undefined;
    }
  }

  retry(ply = this.foreground): void {
    if (
      !this.history ||
      ply === undefined ||
      ply < 0 ||
      ply > this.history.moves.length ||
      !Number.isInteger(ply)
    ) {
      return;
    }
    if (!this.fault && this.states.get(ply)?.status !== "unavailable") return;
    if (this.fault) this.worker.retry();
    this.fault = false;
    this.setState(ply, { ...this.states.get(ply), status: "pending", reason: undefined });
    this.show(ply);
    this.publish();
  }

  dispose(): void {
    if (!this.history) return;
    this.suspend();
    this.history = null;
    this.foreground = undefined;
    this.states.clear();
    this.worker.dispose();
    this.publish();
    this.listeners.clear();
  }

  private missing(ply: number): boolean {
    const state = this.states.get(ply);
    return state?.status !== "unavailable" && state?.sample?.profileId !== PROFILE_ID;
  }

  private fen(ply: number): string {
    return this.history?.moves[ply - 1]?.fen ?? this.history?.initialFen ?? "";
  }

  private schedule(): void {
    if (
      !this.history ||
      this.hidden ||
      this.fault ||
      this.active ||
      this.timer !== undefined ||
      this.foreground === undefined
    ) {
      return;
    }
    const wait = Math.max(0, this.lastCompleted + 250 - performance.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.dispatch();
    }, wait);
  }

  private async dispatch(): Promise<void> {
    const history = this.history;
    if (!history || this.hidden || this.fault || this.active || this.foreground === undefined) {
      return;
    }
    let gap: number | undefined;
    for (let ply = 0; ply <= history.moves.length; ply++) {
      if (this.missing(ply)) {
        gap = ply;
        break;
      }
    }
    if (gap === undefined) return;
    const historical = !this.missing(this.foreground) || this.foregroundDispatches >= 2;
    const dispatch: Dispatch = {
      ply: historical ? gap : this.foreground,
      historical,
      cancelled: false,
    };
    this.active = dispatch;
    const epoch = this.epoch;
    this.setState(dispatch.ply, { ...this.states.get(dispatch.ply), status: "computing" });
    this.publish();
    let result: SearchOutcome;
    try {
      const moves = history.moves.slice(0, dispatch.ply).map((move) => move.uci);
      const digest = await historyDigest(moves);
      if (epoch !== this.epoch || !this.history) return;
      if (dispatch.cancelled) result = { status: "cancelled" };
      else {
        if (!historical) this.foregroundDispatches++;
        result = await this.worker.analyze({
          lifetime: history.lifetime,
          gameId: history.gameId,
          ply: dispatch.ply,
          fen: this.fen(dispatch.ply),
          moves,
          historyDigest: digest,
          profileId: PROFILE_ID,
        });
      }
    } catch {
      result = { status: "unavailable", reason: "unsupported_browser", fatal: true };
    }
    if (epoch !== this.epoch || !this.history) return;
    this.active = undefined;
    const prior = this.states.get(dispatch.ply);
    if (result.status === "ready") {
      const retained = prior?.sample;
      const sample =
        retained?.profileId === PROFILE_ID && retained.depth >= result.sample.depth
          ? retained
          : result.sample;
      this.setState(dispatch.ply, { status: "ready", sample });
    } else if (result.status === "unavailable") {
      this.setState(dispatch.ply, { ...prior, status: "unavailable", reason: result.reason });
      this.fault = result.fatal;
    } else this.setState(dispatch.ply, { ...prior, status: "pending" });
    if (result.status !== "cancelled") {
      this.lastCompleted = performance.now();
      if (historical) this.foregroundDispatches = 0;
    }
    this.publish();
    this.schedule();
  }

  private setState(ply: number, state: PlyState): void {
    if (state.sample?.profileId === PROFILE_ID) state = { status: "ready", sample: state.sample };
    if (state.sample) {
      Object.freeze(state.sample.score);
      Object.freeze(state.sample);
    }
    this.states.set(ply, Object.freeze(state));
  }

  private publish(): void {
    this.listeners.forEach((listener) => listener());
  }
}
