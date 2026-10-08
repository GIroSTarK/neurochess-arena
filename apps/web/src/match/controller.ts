import {
  type AiControlledTurnCommand,
  type ChessColor,
  type CredentialMetadata,
  type GameDetails,
  type GameInvocations,
  type GameReplayResponse,
  type GameSnapshot,
  type LifecycleCommand,
  type MoveCommand,
  type ProviderFailure,
  sessionApiKeySchema,
} from "@neurochess/contracts";

import { type AiApi, AiRequestFailure } from "../api/ai-client";
import { ApiFailure } from "../api/failures";
import { createSessionCredentials } from "../api/session-credentials";
import { parseGameId } from "../app/route-urls";
import { browserPgnDelivery, type PgnDelivery } from "../position/pgn";

export type MatchIssue =
  | { kind: "notice"; code: "recovered" | "uncertain" | "unavailable" | "access" }
  | { kind: "request"; code: AiRequestFailure["code"] }
  | { kind: "provider"; color: ChessColor; error: ProviderFailure };

export interface MatchState {
  phase: "loading" | "setup" | "ready" | "recovering" | "uncertain" | "unavailable";
  details: GameDetails | null;
  thinking: boolean;
  busy: boolean;
  keys: Record<ChessColor, boolean>;
  selections: Record<ChessColor, string>;
  keyEpoch: number;
  speed: number;
  issue: MatchIssue | null;
  startedGameId: string | null;
  replay: GameReplayResponse | null;
  replayPly: number;
  replayLoading: boolean;
  replayError: boolean;
  exportBusy: boolean;
  exportResult: "copied" | "downloaded" | "manual" | "error" | null;
  exportText: string | null;
  invocations: GameInvocations | null;
  invocationsMoveCount: number;
  invocationsLoading: boolean;
  invocationsError: boolean;
}

const terminal = (snapshot: GameSnapshot) =>
  snapshot.state === "completed" || snapshot.state === "aborted";
const colors = ["white", "black"] as const;

export type MatchEntry =
  | { readonly kind: "setup" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable"; readonly code: "access" | "unavailable" }
  | { readonly kind: "game"; readonly gameId: string; readonly details: GameDetails };

export interface MatchNavigation {
  game(gameId: string, reason: "created" | "recovered"): void;
  setup(): void;
}

export function humanColor(details: GameDetails | null): ChessColor | null {
  const configuration = details?.configuration;
  return configuration?.mode === "ai_vs_human"
    ? configuration.seats.white.type === "human"
      ? "white"
      : "black"
    : null;
}

export function matchKeysReady(state: MatchState): boolean {
  const configuration = state.details?.configuration;
  return (
    configuration !== null &&
    configuration !== undefined &&
    colors.every((color) => configuration.seats[color].type === "human" || state.keys[color])
  );
}

export class MatchController {
  credentials: ReturnType<typeof createSessionCredentials> | null = null;
  private lifetime: AbortController | null = null;
  private controllerId = "";
  private lease = false;
  private running = false;
  private nextTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private invocationTimer: ReturnType<typeof setTimeout> | undefined;
  private invocationRequest: AbortController | null = null;
  private turn: { command: AiControlledTurnCommand; abort: AbortController } | null = null;
  private control: LifecycleCommand | null = null;
  private humanCommand: MoveCommand | null = null;
  private readonly listeners = new Set<() => void>();
  private state: MatchState = {
    phase: "loading",
    details: null,
    thinking: false,
    busy: false,
    keys: { white: false, black: false },
    selections: { white: "session", black: "session" },
    keyEpoch: 0,
    speed: 1500,
    issue: null,
    startedGameId: null,
    replay: null,
    replayPly: 0,
    replayLoading: false,
    replayError: false,
    exportBusy: false,
    exportResult: null,
    exportText: null,
    invocations: null,
    invocationsMoveCount: 0,
    invocationsLoading: false,
    invocationsError: false,
  };

  constructor(
    readonly api: AiApi,
    private readonly delivery: PgnDelivery = browserPgnDelivery,
    private readonly navigation?: MatchNavigation,
  ) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<MatchState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }

  private openLifetime() {
    this.lifetime = new AbortController();
    this.credentials = createSessionCredentials(this.lifetime.signal);
    this.controllerId = crypto.randomUUID();
    return this.lifetime.signal;
  }
  private stopRunning() {
    this.running = false;
    clearTimeout(this.nextTimer);
  }
  endLifetime() {
    if (!this.lifetime) return;
    this.stopRunning();
    this.clearInvocations();
    clearTimeout(this.heartbeatTimer);
    this.lease = false;
    this.turn?.abort.abort();
    this.turn = null;
    this.control = null;
    this.humanCommand = null;
    this.lifetime.abort();
    this.lifetime = null;
    this.credentials = null;
    this.publish({
      phase: "loading",
      details: null,
      keys: { white: false, black: false },
      selections: { white: "session", black: "session" },
      keyEpoch: this.state.keyEpoch + 1,
      thinking: false,
      busy: false,
      replay: null,
      replayLoading: false,
      replayError: false,
      exportText: null,
      exportBusy: false,
      exportResult: null,
      startedGameId: null,
      issue: null,
      replayPly: 0,
    });
  }
  private live(signal: AbortSignal) {
    return !signal.aborted && this.lifetime !== null;
  }
  async enter(entry: MatchEntry): Promise<void> {
    this.endLifetime();
    const signal = this.openLifetime();
    const id = entry.kind === "game" ? parseGameId(entry.gameId) : null;
    if (entry.kind === "setup") {
      this.publish({ phase: "setup", details: null, issue: null });
      return;
    }
    if (!id || entry.kind !== "game") {
      this.publish({
        phase: "unavailable",
        details: null,
        issue: { kind: "notice", code: entry.kind === "unavailable" ? entry.code : "access" },
      });
      return;
    }
    this.publish({ phase: "loading", details: null, issue: null, replay: null });
    try {
      // Seeded entries also yield so a discarded mount cannot begin recovery writes.
      const details = await Promise.resolve(entry.details);
      if (!this.live(signal)) return;
      if (parseGameId(details.snapshot.gameId) !== id) throw new ApiFailure("malformed");
      this.publish({ details, phase: "ready" });
      this.navigation?.game(id, "recovered");
      if (!this.live(signal)) return;
      void this.loadInvocations();
      if (terminal(details.snapshot)) await this.loadReplay();
      else if (details.configuration) await this.recover(details.snapshot);
    } catch (error) {
      if (this.live(signal)) this.fail(error, "unavailable");
    }
  }

  async created(details: GameDetails) {
    if (!this.lifetime || this.state.busy || this.state.phase !== "setup") return;
    this.clearInvocations();
    this.publish({ details, phase: "ready", startedGameId: details.snapshot.gameId, issue: null });
    this.refreshKeys();
    const signal = this.lifetime.signal;
    this.navigation?.game(details.snapshot.gameId, "created");
    if (!this.live(signal)) return;
    void this.loadInvocations();
    await this.continue(false, true);
  }
  private refreshKeys() {
    const keys = { white: false, black: false };
    const selections = { white: "session", black: "session" };
    for (const color of colors) {
      const seat = this.state.details?.configuration?.seats[color];
      if (seat?.type !== "ai") continue;
      try {
        const source = this.credentials?.require(color, seat.provider);
        keys[color] = Boolean(source);
        if (source && "credentialId" in source) selections[color] = source.credentialId;
      } catch {
        /* Missing keys are expected after recovery. */
      }
    }
    this.publish({ keys, selections });
  }
  setCredential(color: ChessColor, credential: string, saved: readonly CredentialMetadata[]) {
    const seat = this.state.details?.configuration?.seats[color];
    if (
      seat?.type !== "ai" ||
      !this.credentials ||
      this.state.thinking ||
      this.state.busy ||
      this.state.details?.snapshot.state !== "paused"
    ) {
      return;
    }
    if (
      credential !== "session" &&
      !saved.some((item) => item.credentialId === credential && item.provider === seat.provider)
    ) {
      return;
    }
    this.credentials.remove(color);
    if (credential !== "session") this.credentials.setSaved(color, seat.provider, credential);
    this.refreshKeys();
  }
  reconcileSavedCredentials(saved: readonly CredentialMetadata[]) {
    if (this.state.details?.snapshot.state !== "paused" || this.state.thinking || this.state.busy) {
      return;
    }
    let changed = false;
    for (const color of colors) {
      const selected = this.state.selections[color];
      const seat = this.state.details.configuration?.seats[color];
      if (
        selected !== "session" &&
        seat?.type === "ai" &&
        !saved.some((item) => item.credentialId === selected && item.provider === seat.provider)
      ) {
        this.credentials?.remove(color);
        changed = true;
      }
    }
    if (changed) {
      this.refreshKeys();
      this.publish({ keyEpoch: this.state.keyEpoch + 1 });
    }
  }
  setKey(color: ChessColor, value: string) {
    const seat = this.state.details?.configuration?.seats[color];
    if (seat?.type !== "ai" || !this.credentials || this.state.thinking || this.state.busy) return;
    this.credentials.remove(color);
    if (sessionApiKeySchema.safeParse(value).success) {
      this.credentials.set(color, seat.provider, value);
    }
    this.refreshKeys();
  }
  setSpeed(speed: number) {
    if (![500, 1500, 5000].includes(speed)) return;
    this.publish({ speed });
    if (this.running && !this.turn) this.schedule();
  }

  private adopt(snapshot: GameSnapshot) {
    const previous = this.state.details;
    if (
      snapshot.gameId !== previous?.snapshot.gameId ||
      snapshot.version < previous.snapshot.version
    ) {
      return;
    }
    const changed = snapshot.version !== previous.snapshot.version;
    if (changed) this.cancelInvocationRead();
    this.publish({ details: { ...previous, snapshot } });
    if (changed) void this.loadInvocations();
    if (snapshot.state !== "active") this.stopRunning();
    if (terminal(snapshot)) {
      clearTimeout(this.heartbeatTimer);
      this.lease = false;
      this.publish({ phase: "ready", issue: null });
      void this.loadReplay();
    }
  }
  private async acquire(signal: AbortSignal) {
    const snapshot = this.snapshot();
    const accepted = await this.api.controller(
      {
        gameId: snapshot.gameId,
        controllerId: this.controllerId,
        expectedVersion: snapshot.version,
        action: "acquire",
      },
      signal,
    );
    if (!this.live(signal)) return false;
    this.adopt(accepted);
    this.lease = true;
    this.heartbeat();
    return true;
  }
  private heartbeat() {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      void this.beat();
    }, 3000);
  }
  private async beat() {
    const signal = this.lifetime?.signal;
    const snapshot = this.state.details?.snapshot;
    if (!signal || !snapshot || !this.lease || terminal(snapshot)) return;
    try {
      const accepted = await this.api.controller(
        { gameId: snapshot.gameId, controllerId: this.controllerId, action: "heartbeat" },
        signal,
      );
      if (!this.live(signal) || !this.hasLease()) return;
      this.adopt(accepted);
      if (this.hasLease()) this.heartbeat();
    } catch (error) {
      if (!this.live(signal)) return;
      this.lease = false;
      this.stopRunning();
      this.fail(error);
    }
  }
  async continue(step: boolean, created = false) {
    const signal = this.lifetime?.signal;
    const snapshot = this.state.details?.snapshot;
    if (
      !signal ||
      !snapshot ||
      this.state.busy ||
      this.turn ||
      this.humanCommand ||
      this.state.phase !== "ready" ||
      !matchKeysReady(this.state) ||
      (step && this.state.details?.configuration?.seats[snapshot.turn].type !== "ai") ||
      (created ? snapshot.state !== "active" : snapshot.state !== "paused")
    ) {
      return;
    }
    this.publish({ busy: true, issue: null });
    let dispatch = false;
    try {
      if (!(await this.acquire(signal))) return;
      if (!created && !step) {
        const command: LifecycleCommand = {
          ...this.command(),
          action: "resume",
          controllerId: this.controllerId,
        };
        this.control = command;
        const snapshot = await this.api.lifecycle(command, signal);
        if (!this.live(signal)) return;
        this.adopt(snapshot);
        this.control = null;
      }
      if (!this.live(signal)) return;
      this.running = !step;
      dispatch = true;
    } catch (error) {
      if (this.live(signal)) this.fail(error);
    } finally {
      if (this.live(signal)) this.publish({ busy: false });
    }
    if (dispatch && this.live(signal)) await this.executeTurn(step);
  }
  private command() {
    const snapshot = this.snapshot();
    return {
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: crypto.randomUUID(),
    };
  }
  private snapshot() {
    const snapshot = this.state.details?.snapshot;
    if (!snapshot) throw new ApiFailure("malformed");
    return snapshot;
  }
  private hasLease() {
    return this.lease;
  }
  private schedule() {
    clearTimeout(this.nextTimer);
    const details = this.state.details;
    if (
      this.running &&
      !this.turn &&
      !this.humanCommand &&
      !this.state.busy &&
      this.state.phase === "ready" &&
      details?.configuration?.seats[details.snapshot.turn].type === "ai"
    ) {
      this.nextTimer = setTimeout(() => {
        void this.executeTurn(false);
      }, this.state.speed);
    }
  }
  private async executeTurn(step: boolean) {
    const signal = this.lifetime?.signal;
    const details = this.state.details;
    if (
      !signal ||
      !details ||
      !this.lease ||
      this.turn ||
      this.humanCommand ||
      this.state.busy ||
      this.state.phase !== "ready"
    ) {
      return;
    }
    if (details.snapshot.state !== (step ? "paused" : "active")) return;
    const seat = details.configuration?.seats[details.snapshot.turn];
    if (seat?.type !== "ai" || !this.credentials) return;
    const request = {
      command: { ...this.command(), controllerId: this.controllerId, step },
      abort: new AbortController(),
    };
    this.turn = request;
    this.publish({ thinking: true, issue: null });
    try {
      const accepted = await this.api.turn(
        request.command,
        this.credentials.require(details.snapshot.turn, seat.provider),
        AbortSignal.any([signal, request.abort.signal]),
      );
      if (!this.live(signal) || this.turn !== request) return;
      this.adopt(accepted);
      this.turn = null;
      this.publish({ thinking: false });
      void this.loadInvocations();
      this.schedule();
    } catch (error) {
      if (!this.live(signal) || this.turn !== request) return;
      this.stopRunning();
      this.publish({ thinking: false });
      // Keep the original identity until a newer revision or a versioned pause fences it.
      this.fail(error);
    }
  }
  private cancelInvocationRead() {
    clearTimeout(this.invocationTimer);
    this.invocationRequest?.abort();
    this.invocationRequest = null;
  }
  private clearInvocations() {
    this.cancelInvocationRead();
    this.publish({
      invocations: null,
      invocationsMoveCount: 0,
      invocationsLoading: false,
      invocationsError: false,
    });
  }
  async loadInvocations() {
    const lifetime = this.lifetime?.signal;
    const details = this.state.details;
    if (!lifetime || !details?.configuration || this.invocationRequest) return;
    const snapshot = details.snapshot;
    clearTimeout(this.invocationTimer);
    const request = new AbortController();
    this.invocationRequest = request;
    const signal = AbortSignal.any([lifetime, request.signal]);
    const current = () =>
      this.live(signal) &&
      this.invocationRequest === request &&
      this.state.details?.snapshot.gameId === snapshot.gameId &&
      this.state.details.snapshot.version === snapshot.version;
    this.publish({ invocationsLoading: true, invocationsError: false });
    try {
      const records = await this.api.invocations(snapshot.gameId, signal);
      if (!current()) return;
      if (records.gameId !== snapshot.gameId || records.version < snapshot.version) {
        throw new ApiFailure("malformed");
      }
      if (records.version > snapshot.version) {
        const latest = await this.api.snapshot(snapshot.gameId, signal);
        if (!current()) return;
        this.adopt(latest);
        return;
      }
      // Totals describe the history at this read, even while the next revision is loading.
      this.publish({ invocations: records, invocationsMoveCount: snapshot.moves.length });
      const turn = records.turns.at(-1);
      const attempt = turn?.attempts.at(-1);
      const error = attempt?.error;
      if (
        snapshot.state === "paused" &&
        this.state.phase === "ready" &&
        !this.state.busy &&
        !this.state.thinking &&
        turn?.ply === snapshot.moves.length + 1 &&
        attempt?.outcome === "provider_error" &&
        error &&
        error.code !== "model_invalid"
      ) {
        this.publish({ issue: { kind: "provider", color: turn.color, error } });
      }
    } catch (error) {
      if (current() && !this.accessLost(error)) {
        this.publish({ invocationsError: true });
      }
    } finally {
      if (current()) {
        this.invocationRequest = null;
        this.publish({ invocationsLoading: false });
        // Attempts can finish without a chess revision; reads never authorize another turn.
        if (!terminal(snapshot)) {
          this.invocationTimer = setTimeout(() => {
            void this.loadInvocations();
          }, 3000);
        }
      }
    }
  }

  canMove() {
    const snapshot = this.state.details?.snapshot;
    return (
      this.state.phase === "ready" &&
      this.lease &&
      this.running &&
      !this.state.busy &&
      !this.turn &&
      !this.control &&
      !this.humanCommand &&
      snapshot?.state === "active" &&
      snapshot.turn === humanColor(this.state.details)
    );
  }
  async move(move: string) {
    if (!this.canMove() || !this.snapshot().legalMoves.includes(move)) return;
    this.humanCommand = { ...this.command(), move };
    await this.sendHumanMove(false);
  }
  hasPendingMove() {
    return this.humanCommand !== null;
  }
  async retryMove() {
    if (!this.humanCommand || this.state.busy || this.state.phase !== "uncertain") return;
    await this.sendHumanMove(true);
  }
  private async sendHumanMove(retry: boolean) {
    const signal = this.lifetime?.signal;
    const command = this.humanCommand;
    if (!signal || !command) return;
    this.publish({ busy: true, issue: null });
    try {
      const accepted = await this.api.move(command, signal);
      if (!this.live(signal) || this.humanCommand !== command) return;
      this.adopt(accepted);
      this.humanCommand = null;
    } catch (error) {
      if (!this.live(signal) || this.humanCommand !== command) return;
      this.fail(error);
      if (!this.live(signal)) return;
      try {
        const current = await this.api.snapshot(command.gameId, signal);
        if (!this.live(signal)) return;
        this.adopt(current);
        // Only a newer revision fences an unacknowledged human command.
        if (current.version > command.expectedVersion) this.humanCommand = null;
      } catch (readError) {
        if (this.live(signal)) this.accessLost(readError);
      }
    } finally {
      if (this.live(signal)) this.publish({ busy: false });
    }
    if (!this.live(signal)) return;
    if (retry && !this.humanCommand && !terminal(this.snapshot())) await this.recover();
    else this.schedule();
  }

  async lifecycle(action: "pause" | "abort" | "resign") {
    const snapshot = this.state.details?.snapshot;
    if (!this.lifetime || !snapshot || terminal(snapshot) || this.state.busy) return;
    const losingColor = humanColor(this.state.details);
    if (action === "resign" && (!losingColor || this.state.phase !== "ready")) return;
    this.stopRunning();
    this.control =
      action === "resign" && losingColor
        ? {
            ...this.command(),
            action: "resign",
            losingColor,
          }
        : {
            ...this.command(),
            action: action === "abort" ? "abort" : "pause",
            ...(this.lease ? { controllerId: this.controllerId } : {}),
          };
    await this.sendControl(false);
  }
  async recover(entrySnapshot?: GameSnapshot) {
    const signal = this.lifetime?.signal;
    if (!signal || this.state.busy || !this.state.details) return;
    this.stopRunning();
    this.lease = false;
    clearTimeout(this.heartbeatTimer);
    this.publish({ phase: "recovering", busy: true });
    try {
      const snapshot =
        entrySnapshot ?? (await this.api.snapshot(this.state.details.snapshot.gameId, signal));
      if (!this.live(signal)) return;
      this.adopt(snapshot);
      if (terminal(snapshot)) {
        this.control = null;
        this.humanCommand = null;
        this.turn?.abort.abort();
        this.turn = null;
        return;
      }
      // An uncertain pause is retried verbatim. A conflict proves its old revision cannot commit.
      if (this.control?.action !== "pause") this.control = { ...this.command(), action: "pause" };
      this.publish({ busy: false });
      await this.sendControl(true);
    } catch (error) {
      if (this.live(signal)) this.fail(error);
    } finally {
      if (this.live(signal)) this.publish({ busy: false });
    }
  }
  async retryControl() {
    if (!this.control || this.state.busy || !this.lifetime) return;
    await this.sendControl(this.control.action === "pause" && !("controllerId" in this.control));
  }
  hasPendingControl() {
    return this.control !== null;
  }
  private async sendControl(recovery: boolean) {
    const signal = this.lifetime?.signal;
    if (!signal) return;
    this.publish({ busy: true });
    try {
      for (let tries = 0; tries < 3 && this.control; tries++) {
        const command = this.control;
        try {
          const snapshot = await this.api.lifecycle(command, signal);
          if (!this.live(signal)) return;
          this.adopt(snapshot);
          this.control =
            recovery && "controllerId" in command && !terminal(snapshot)
              ? { ...this.command(), action: "pause" }
              : null;
        } catch (error) {
          if (!this.live(signal)) return;
          if (!(error instanceof ApiFailure) || !error.currentSnapshot) throw error;
          this.adopt(error.currentSnapshot);
          if (command.action === "resign") {
            this.control = null;
            this.fail(error);
            return;
          }
          if (
            terminal(error.currentSnapshot) ||
            (error.currentSnapshot.state === "paused" && !recovery && command.action === "pause")
          ) {
            this.control = null;
          } else {
            this.control = recovery
              ? { ...this.command(), action: "pause" }
              : { ...command, ...this.command() };
          }
        }
      }
      if (this.control) throw new ApiFailure("network");
      this.turn?.abort.abort();
      this.turn = null;
      this.humanCommand = null;
      if (recovery) this.controllerId = crypto.randomUUID();
      this.publish({
        phase: "ready",
        thinking: false,
        issue:
          recovery && !terminal(this.snapshot()) ? { kind: "notice", code: "recovered" } : null,
      });
      void this.loadInvocations();
    } catch (error) {
      if (this.live(signal)) this.fail(error);
    } finally {
      if (this.live(signal)) this.publish({ busy: false });
    }
  }
  private accessLost(error: unknown) {
    if (
      error instanceof ApiFailure &&
      ["UNAUTHORIZED", "PROFILE_REQUIRED", "FORBIDDEN", "NOT_FOUND"].includes(error.code ?? "")
    ) {
      this.endLifetime();
      this.publish({
        phase: "unavailable",
        details: null,
        issue: { kind: "notice", code: "access" },
      });
      return true;
    }
    return false;
  }
  private fail(error: unknown, phase: "uncertain" | "unavailable" = "uncertain") {
    this.stopRunning();
    this.lease = false;
    clearTimeout(this.heartbeatTimer);
    if (this.accessLost(error)) return;
    if (error instanceof ApiFailure && error.currentSnapshot) {
      this.adopt(error.currentSnapshot);
      if (terminal(error.currentSnapshot)) {
        this.turn?.abort.abort();
        this.turn = null;
        this.control = null;
        this.humanCommand = null;
        this.publish({ phase: "ready", thinking: false, issue: null });
        return;
      }
    }
    this.publish({
      phase,
      issue:
        error instanceof AiRequestFailure
          ? { kind: "request", code: error.code }
          : { kind: "notice", code: phase },
    });
  }

  async loadReplay() {
    const signal = this.lifetime?.signal;
    const snapshot = this.state.details?.snapshot;
    if (
      !signal ||
      !snapshot ||
      !terminal(snapshot) ||
      this.state.replayLoading ||
      this.state.replay
    ) {
      return;
    }
    this.publish({ replayLoading: true, replayError: false });
    try {
      const replay = await this.api.replay(snapshot.gameId, signal);
      if (
        !this.live(signal) ||
        this.state.details?.snapshot.gameId !== snapshot.gameId ||
        this.state.details.snapshot.version !== snapshot.version
      ) {
        return;
      }
      if (replay.snapshot.version !== snapshot.version || replay.snapshot.pgn !== snapshot.pgn) {
        throw new ApiFailure("malformed");
      }
      this.publish({ replay, replayPly: snapshot.moves.length });
    } catch (error) {
      if (this.live(signal) && !this.accessLost(error)) this.publish({ replayError: true });
    } finally {
      if (this.live(signal)) this.publish({ replayLoading: false });
    }
  }
  selectPly(ply: number) {
    if (
      this.state.replay &&
      Number.isInteger(ply) &&
      ply >= 0 &&
      ply <= this.state.replay.snapshot.moves.length
    ) {
      this.publish({ replayPly: ply });
    }
  }
  async exportPgn(kind: "copy" | "download") {
    const signal = this.lifetime?.signal;
    const snapshot = this.state.details?.snapshot;
    if (!signal || !snapshot || !terminal(snapshot) || this.state.exportBusy) return;
    this.publish({ exportBusy: true, exportResult: null, exportText: null });
    try {
      const response = await this.api.pgn(snapshot.gameId, signal);
      if (!this.live(signal)) return;
      if (response.version !== snapshot.version || response.pgn !== snapshot.pgn) {
        throw new ApiFailure("malformed");
      }
      const result =
        kind === "copy"
          ? (await this.delivery.copy(response.pgn))
            ? "copied"
            : "manual"
          : "downloaded";
      if (!this.live(signal)) return;
      if (kind === "download") this.delivery.download(response.pgn, snapshot.gameId);
      this.publish({ exportResult: result, exportText: result === "manual" ? response.pgn : null });
    } catch (error) {
      if (this.live(signal) && !this.accessLost(error)) this.publish({ exportResult: "error" });
    } finally {
      if (this.live(signal)) this.publish({ exportBusy: false });
    }
  }
  newGame() {
    if (this.state.details && !terminal(this.state.details.snapshot)) return;
    this.endLifetime();
    this.navigation?.setup();
  }
}
