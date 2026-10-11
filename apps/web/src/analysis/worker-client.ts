import {
  type AnalysisRequest,
  type AnalysisSample,
  type AnalysisTarget,
  ENGINE_DIRECTORY,
  type PositionFacts,
  sampleIdentity,
  type UnavailableReason,
  validateRequest,
} from "./protocol";
import { parseCompletion, parseScore, profileCommands, UciLines } from "./uci";

export interface EngineWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(command: string): void;
  terminate(): void;
}
export type SearchOutcome =
  | { readonly status: "ready"; readonly sample: AnalysisSample }
  | { readonly status: "unavailable"; readonly reason: UnavailableReason; readonly fatal: boolean }
  | { readonly status: "cancelled" };
type Phase = "idle" | "uci" | "initializing" | "resetting" | "searching" | "stopping" | "draining";
interface Search {
  readonly resolve: (outcome: SearchOutcome) => void;
  readonly validation: AbortController;
  request?: AnalysisRequest;
  position?: PositionFacts;
  best?: ReturnType<typeof parseScore>;
  started: number;
  cancelled: boolean;
  timedOut: boolean;
}

export function engineAssetUrl(base = import.meta.env.BASE_URL): URL {
  return new URL(`${base}${ENGINE_DIRECTORY}/stockfish-19-lite-single.js`, location.origin);
}

export class AnalysisWorkerClient {
  private worker: EngineWorker | undefined;
  private generation = 0;
  private phase: Phase = "idle";
  private active: Search | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fault: UnavailableReason | undefined;
  private disposed = false;
  private options: string[] = [];

  constructor(
    private readonly dependencies: {
      createWorker?: () => EngineWorker;
      supported?: () => boolean;
    } = {},
  ) {}

  analyze(target: AnalysisTarget): Promise<SearchOutcome> {
    if (this.disposed) return Promise.resolve({ status: "cancelled" });
    if (this.fault) {
      return Promise.resolve({ status: "unavailable", reason: this.fault, fatal: true });
    }
    if (this.active) throw new Error("analysis_busy");
    const supported =
      this.dependencies.supported ??
      (() =>
        typeof Worker !== "undefined" &&
        typeof WebAssembly !== "undefined" &&
        Boolean(crypto.subtle));
    if (!supported()) {
      this.fault = "unsupported_browser";
      return Promise.resolve({ status: "unavailable", reason: this.fault, fatal: true });
    }
    return new Promise((resolve) => {
      const search: Search = {
        resolve,
        validation: new AbortController(),
        started: 0,
        cancelled: false,
        timedOut: false,
      };
      this.active = search;
      void validateRequest(
        {
          ...target,
          generation: this.worker ? this.generation : this.generation + 1,
        },
        search.validation.signal,
      )
        .then(({ request, position }) => {
          if (this.active !== search || this.disposed) return;
          search.request = request;
          search.position = position;
          if (!this.worker) this.initialize();
          else this.reset();
        })
        .catch(() => {
          if (this.active === search) this.fail("engine_protocol_error");
        });
    });
  }

  cancel(): void {
    if (!this.active) return;
    this.active.cancelled = true;
    if (this.phase === "searching") this.stop();
    else if (this.phase === "idle") this.finish({ status: "cancelled" });
  }

  suspend(): void {
    this.destroyWorker();
    this.finish({ status: "cancelled" });
  }

  retry(): void {
    if (this.disposed || !this.fault) return;
    this.suspend();
    this.fault = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.suspend();
  }

  private initialize(): void {
    try {
      const worker: EngineWorker = (
        this.dependencies.createWorker ??
        (() => new Worker(engineAssetUrl(), { name: "stockfish-analysis" }))
      )();
      this.worker = worker;
      const generation = ++this.generation;
      const lines = new UciLines();
      this.options = [];
      this.phase = "uci";
      worker.onmessage = (event) => {
        if (this.worker !== worker || this.generation !== generation) return;
        try {
          // The pinned engine posts complete print lines. The stream parser also
          // accepts newline-delimited batches; no raw output survives parsing.
          const data = event.data;
          for (const line of lines.push(typeof data === "string" ? `${data}\n` : data)) {
            if (this.worker !== worker) break;
            this.receive(line);
          }
        } catch (error) {
          this.fail(
            error instanceof Error && error.message === "resource_limit"
              ? "resource_limit"
              : "engine_protocol_error",
          );
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker === worker) {
          this.fail(
            this.phase === "uci" || this.phase === "initializing"
              ? "engine_load_failed"
              : "engine_crashed",
          );
        }
      };
      worker.onmessageerror = () => {
        if (this.worker === worker) this.fail("engine_protocol_error");
      };
      this.deadline(15000, "initialization_timeout");
      this.send("uci");
    } catch {
      this.fail("engine_load_failed");
    }
  }

  private receive(line: string): void {
    if (/out of memory|cannot enlarge memory|memory access out of bounds/i.test(line)) {
      this.fail("resource_limit");
      return;
    }
    if (this.phase === "uci") {
      if (line.startsWith("option ")) {
        if (this.options.length >= 64) {
          this.fail("resource_limit");
          return;
        }
        this.options.push(line);
      } else if (line === "uciok") {
        for (const command of profileCommands(this.options)) this.send(command);
        this.options = [];
        this.phase = "initializing";
        this.send("isready");
      }
      return;
    }
    if (line === "readyok") {
      if (this.phase === "initializing") {
        this.clearTimer();
        this.reset();
      } else if (this.phase === "resetting") this.beginSearch();
      else if (this.phase === "draining") this.completeStopped();
      return;
    }
    const search = this.active;
    if (!search?.position) return;
    if (this.phase === "searching" && line.startsWith("info ")) {
      const parsed = parseScore(line, search.position);
      if (parsed && (!search.best || parsed.depth >= search.best.depth)) search.best = parsed;
    }
    if (line.startsWith("bestmove") && (this.phase === "searching" || this.phase === "stopping")) {
      if (!parseCompletion(line, search.position.noLegalMoves)) {
        this.fail("engine_protocol_error");
        return;
      }
      if (this.phase === "stopping") {
        this.phase = "draining";
        this.deadline(1000, "engine_protocol_error");
        this.send("isready");
      } else this.complete();
    }
  }

  private reset(): void {
    if (!this.active || this.active.cancelled) {
      this.finish({ status: "cancelled" });
      return;
    }
    this.phase = "resetting";
    this.deadline(1000, "engine_protocol_error");
    this.send("ucinewgame");
    this.send("isready");
  }

  private beginSearch(): void {
    const search = this.active;
    if (!search?.request || search.cancelled) {
      this.finish({ status: "cancelled" });
      return;
    }
    this.clearTimer();
    this.phase = "searching";
    const moves = search.request.moves;
    this.send(moves.length ? `position startpos moves ${moves.join(" ")}` : "position startpos");
    search.started = performance.now();
    this.timer = setTimeout(() => {
      if (this.active !== search) return;
      search.timedOut = true;
      this.stop();
    }, 2000);
    this.send("go depth 18 nodes 1000000 movetime 1000");
  }

  private stop(): void {
    this.phase = "stopping";
    this.deadline(1000, this.active?.timedOut ? "search_timeout" : "engine_protocol_error");
    this.send("stop");
  }

  private completeStopped(): void {
    this.finish(
      this.active?.timedOut
        ? { status: "unavailable", reason: "search_timeout", fatal: false }
        : { status: "cancelled" },
    );
  }

  private complete(): void {
    const search = this.active;
    if (!search?.request) return;
    const durationMs = Math.max(0, Math.floor(performance.now() - search.started));
    if (durationMs > 3000) {
      this.finish({ status: "unavailable", reason: "search_timeout", fatal: false });
    } else if (!search.best) {
      this.finish({ status: "unavailable", reason: "no_score", fatal: false });
    } else {
      this.finish({
        status: "ready",
        sample: { ...sampleIdentity(search.request), ...search.best, durationMs },
      });
    }
  }

  private finish(outcome: SearchOutcome): void {
    this.clearTimer();
    const search = this.active;
    this.active = undefined;
    search?.validation.abort();
    this.phase = "idle";
    search?.resolve(outcome);
  }

  private send(command: string): void {
    try {
      this.worker?.postMessage(command);
    } catch {
      this.fail("engine_crashed");
    }
  }

  private deadline(ms: number, reason: UnavailableReason): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.fail(reason), ms);
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private destroyWorker(): void {
    this.clearTimer();
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    this.options = [];
  }

  private fail(reason: UnavailableReason): void {
    this.fault = reason;
    this.destroyWorker();
    this.finish({ status: "unavailable", reason, fatal: true });
  }
}
