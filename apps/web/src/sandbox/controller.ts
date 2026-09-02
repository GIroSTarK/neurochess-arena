import type { GameErrorCode, GameSnapshot, MoveCommand } from "@neurochess/contracts";

import { ApiFailure, type SandboxApi } from "../api";

export type SandboxNotice =
  | GameErrorCode
  | "existing"
  | "sandbox-unavailable"
  | "network"
  | "timeout"
  | "malformed"
  | "uncertain"
  | "sync-required"
  | "synchronized";
export type SandboxPhase =
  | "entry"
  | "starting"
  | "ready"
  | "submitting"
  | "synchronizing"
  | "uncertain"
  | "sync-required"
  | "unavailable"
  | "access-error";

export type Announcement =
  | {
      readonly kind: "started" | "existing" | "move" | "synchronized";
      readonly snapshot: GameSnapshot;
    }
  | { readonly kind: "rejected"; readonly snapshot: GameSnapshot; readonly reason: SandboxNotice }
  | { readonly kind: "notice"; readonly notice: SandboxNotice }
  | { readonly kind: "connection"; readonly readiness: "ready" | "unavailable" };

export interface SandboxState {
  readonly readiness: "checking" | "ready" | "unavailable";
  readonly phase: SandboxPhase;
  readonly snapshot: GameSnapshot | null;
  readonly pendingCommand: MoveCommand | null;
  readonly notice: SandboxNotice | null;
  readonly announcement: Announcement | null;
  /** Invalidates selection/promotion without remounting or focusing the board. */
  readonly interactionRevision: number;
}

interface Operation {
  readonly generation: number;
  readonly abort: AbortController;
}

const accessCodes = new Set<GameErrorCode>(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"]);
const rejectionCodes = new Set<GameErrorCode>([
  "INVALID_REQUEST",
  "INVALID_UCI",
  "ILLEGAL_MOVE",
  "INVALID_GAME_STATE",
]);

export class SandboxController {
  private state: SandboxState = {
    readiness: "checking",
    phase: "entry",
    snapshot: null,
    pendingCommand: null,
    notice: null,
    announcement: null,
    interactionRevision: 0,
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private connected = true;
  private operation: Operation | null = null;
  private readinessAbort: AbortController | null = null;

  constructor(
    private readonly api: SandboxApi,
    private readonly commandId: () => string = () => crypto.randomUUID(),
  ) {}

  readonly getSnapshot = (): SandboxState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(): () => void {
    this.connected = true;
    void this.checkReadiness();
    return () => this.disconnect();
  }

  disconnect(): void {
    this.connected = false;
    this.generation += 1;
    this.operation?.abort.abort();
    this.operation = null;
    this.readinessAbort?.abort();
    this.readinessAbort = null;
    if (this.state.pendingCommand) {
      this.update({ phase: "uncertain", notice: "uncertain" });
    } else if (this.state.phase === "synchronizing") {
      this.update({ phase: "sync-required", notice: "sync-required" });
    } else if (this.state.phase === "starting") {
      this.update({ phase: this.state.snapshot ? "ready" : "entry" });
    }
  }

  async checkReadiness(): Promise<void> {
    if (!this.connected || this.readinessAbort) return;
    const abort = new AbortController();
    this.readinessAbort = abort;
    const isRetry = this.state.readiness === "unavailable";
    this.update({ readiness: "checking" });
    let readiness: "ready" | "unavailable" = "unavailable";
    try {
      readiness = (await this.api.ready(abort.signal)) ? "ready" : "unavailable";
    } catch {
      // Readiness does not decide sandbox availability or replace a guest.
    }
    if (!this.connected || abort.signal.aborted || this.readinessAbort !== abort) return;
    this.readinessAbort = null;
    this.update({
      readiness,
      ...(isRetry || readiness === "unavailable"
        ? { announcement: { kind: "connection", readiness } as const }
        : {}),
    });
  }

  async start(): Promise<void> {
    if (
      this.state.readiness !== "ready" ||
      this.state.snapshot?.state === "active" ||
      this.state.snapshot?.state === "paused" ||
      this.state.pendingCommand
    )
      return;
    const operation = this.begin();
    if (!operation) return;
    this.update({ phase: "starting", notice: null });
    try {
      // The cookie must exist before creation. No mount effect bootstraps guests.
      await this.api.bootstrap(operation.abort.signal);
      if (!this.current(operation)) return;
      const snapshot = await this.api.create(operation.abort.signal);
      if (this.current(operation)) this.accept(snapshot, "started", null);
    } catch (error: unknown) {
      if (!this.current(operation)) return;
      const failure = safeFailure(error);
      if (failure.code === "GAME_CONFLICT" && failure.currentSnapshot) {
        this.accept(failure.currentSnapshot, "existing", "existing");
      } else {
        const notice =
          failure.code === "NOT_FOUND" ? "sandbox-unavailable" : failureNotice(failure);
        this.update({
          snapshot: null,
          pendingCommand: null,
          phase: failure.code === "NOT_FOUND" ? "unavailable" : "entry",
          notice,
          announcement: { kind: "notice", notice },
          interactionRevision: this.state.interactionRevision + 1,
        });
      }
    } finally {
      this.finish(operation);
    }
  }

  async submit(move: string): Promise<void> {
    const snapshot = this.state.snapshot;
    if (
      this.state.phase !== "ready" ||
      !snapshot ||
      snapshot.state !== "active" ||
      !snapshot.legalMoves.includes(move)
    )
      return;
    // Acquired synchronously, before generating a command or notifying React.
    const operation = this.begin();
    if (!operation) return;
    const command: MoveCommand = {
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: this.commandId(),
      move,
    };
    this.update({ pendingCommand: command });
    await this.sendMove(operation, command);
  }

  async retryMove(): Promise<void> {
    const command = this.state.pendingCommand;
    if (this.state.phase !== "uncertain" || !command) return;
    const operation = this.begin();
    if (operation) await this.sendMove(operation, command);
  }

  async synchronize(): Promise<void> {
    if (!["uncertain", "sync-required"].includes(this.state.phase) || !this.state.snapshot) return;
    const operation = this.begin();
    if (!operation) return;
    try {
      await this.readBack(operation);
    } finally {
      this.finish(operation);
    }
  }

  private async sendMove(operation: Operation, command: MoveCommand): Promise<void> {
    this.update({ phase: "submitting", notice: null });
    try {
      const snapshot = await this.api.move(command, operation.abort.signal);
      if (!this.current(operation)) return;
      if (
        !this.validRevision(snapshot, command.gameId) ||
        snapshot.version <= command.expectedVersion
      ) {
        throw new ApiFailure("malformed");
      }
      this.accept(snapshot, "move", null);
    } catch (error: unknown) {
      if (!this.current(operation)) return;
      const failure = safeFailure(error);
      if (this.loseAccess(failure)) return;
      if (
        failure.code === "GAME_CONFLICT" &&
        failure.currentSnapshot &&
        this.validRevision(failure.currentSnapshot, command.gameId)
      ) {
        this.accept(failure.currentSnapshot, "synchronized", "GAME_CONFLICT");
        return;
      }
      const rejection = failure.code && rejectionCodes.has(failure.code) ? failure.code : undefined;
      if (rejection) this.update({ pendingCommand: null });
      // A failed response can follow a committed write. Never resend implicitly.
      await this.readBack(operation, rejection);
    } finally {
      this.finish(operation);
    }
  }

  private async readBack(operation: Operation, rejection?: SandboxNotice): Promise<void> {
    const accepted = this.state.snapshot;
    if (!accepted || !this.current(operation)) return;
    this.update({ phase: "synchronizing", notice: rejection ?? null });
    try {
      const snapshot = await this.api.snapshot(accepted.gameId, operation.abort.signal);
      if (!this.current(operation)) return;
      if (!this.validRevision(snapshot, accepted.gameId)) throw new ApiFailure("malformed");
      const pending = this.state.pendingCommand;
      if (pending && snapshot.version === pending.expectedVersion) {
        // An unchanged GET cannot prove a timed-out POST will not commit later.
        this.update({
          snapshot,
          phase: "uncertain",
          notice: "uncertain",
          announcement: { kind: "notice", notice: "uncertain" },
          interactionRevision: this.state.interactionRevision + 1,
        });
      } else {
        // A newer aggregate revision also prevents the old command committing.
        this.accept(
          snapshot,
          "synchronized",
          rejection ?? "synchronized",
          rejection ? { kind: "rejected", snapshot, reason: rejection } : undefined,
        );
      }
    } catch (error: unknown) {
      if (!this.current(operation)) return;
      if (this.loseAccess(safeFailure(error))) return;
      const pending = this.state.pendingCommand !== null;
      const notice = pending ? "uncertain" : "sync-required";
      this.update({
        phase: pending ? "uncertain" : "sync-required",
        notice,
        announcement: { kind: "notice", notice },
      });
    }
  }

  private validRevision(snapshot: GameSnapshot, gameId: string): boolean {
    return snapshot.gameId === gameId && snapshot.version >= (this.state.snapshot?.version ?? 0);
  }

  private loseAccess(failure: ApiFailure): boolean {
    if (!failure.code || !accessCodes.has(failure.code)) return false;
    this.update({
      snapshot: null,
      pendingCommand: null,
      phase: "access-error",
      notice: failure.code,
      announcement: { kind: "notice", notice: failure.code },
      interactionRevision: this.state.interactionRevision + 1,
    });
    return true;
  }

  private accept(
    snapshot: GameSnapshot,
    kind: "started" | "existing" | "move" | "synchronized",
    notice: SandboxNotice | null,
    announcement?: Announcement,
  ): void {
    this.update({
      snapshot,
      pendingCommand: null,
      phase: "ready",
      notice,
      announcement: announcement ?? { kind, snapshot },
      interactionRevision: this.state.interactionRevision + 1,
    });
  }

  private begin(): Operation | null {
    if (!this.connected || this.operation) return null;
    const operation = { generation: ++this.generation, abort: new AbortController() };
    this.operation = operation;
    return operation;
  }

  private current(operation: Operation): boolean {
    return (
      this.connected && operation.generation === this.generation && !operation.abort.signal.aborted
    );
  }

  private finish(operation: Operation): void {
    if (this.current(operation)) this.operation = null;
  }

  private update(patch: Partial<SandboxState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

function safeFailure(error: unknown): ApiFailure {
  return error instanceof ApiFailure ? error : new ApiFailure("network");
}

function failureNotice(failure: ApiFailure): SandboxNotice {
  return (
    failure.code ??
    (failure.kind === "api" || failure.kind === "cancelled" ? "network" : failure.kind)
  );
}
