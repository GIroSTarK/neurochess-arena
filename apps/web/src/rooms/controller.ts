import type { GameSnapshot, MoveCommand, RoomServerMessage, RoomView } from "@neurochess/contracts";

import { ApiFailure, RequestRateLimitFailure } from "../api/failures";
import type { RoomGameApi } from "../api/room-game-client";
import type { RoomRealtime } from "../api/room-realtime-client";
import { ArchiveController } from "../gameplay/archive";
import { isAccessFailure } from "../gameplay/failures";
import { browserPgnDelivery, type PgnDelivery } from "../gameplay/pgn";
import { isTerminal } from "../gameplay/snapshot";

import { RoomStore } from "./store";

const reconnectDelays = [250, 1_000, 2_000, 5_000, 10_000];

export class RoomController {
  private readonly store = new RoomStore();
  private readonly archive: ArchiveController;
  private lifetime: AbortController | null = null;
  private closeSocket: (() => void) | null = null;
  private socketEpoch = 0;
  private presenceSequence = 0;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  readonly getSnapshot = this.store.get;
  readonly subscribe = this.store.subscribe;
  readonly authorizeAnalysis = async (gameId: string, signal: AbortSignal) => {
    try {
      await this.api.read(gameId, signal);
    } catch (error) {
      if (!signal.aborted) this.loseAccess(error);
      throw error;
    }
  };

  constructor(
    private readonly api: RoomGameApi,
    private readonly realtime: RoomRealtime,
    delivery: PgnDelivery = browserPgnDelivery,
  ) {
    this.archive = new ArchiveController({
      api,
      delivery,
      store: {
        get: this.store.getArchive,
        setReplay: this.store.setReplay,
        setExport: this.store.setExport,
      },
      isConnected: () => this.lifetime !== null && !this.lifetime.signal.aborted,
      loseAccess: (failure) => this.loseAccess(failure),
    });
  }
  enter(room: RoomView, invitation: string | null = null) {
    this.endLifetime();
    this.lifetime = new AbortController();
    this.store.accept(room);
    this.store.update({
      connection: "connecting",
      invitation: room.state === "waiting" && !isTerminal(room.snapshot) ? invitation : null,
    });
    this.attempts = 0;
    this.connect();
    if (isTerminal(room.snapshot)) void this.archive.loadReplay();
  }
  endLifetime() {
    this.lifetime?.abort();
    this.lifetime = null;
    this.stopSocket();
    this.archive.cancel();
    this.store.clear();
  }
  private stopSocket() {
    ++this.socketEpoch;
    this.closeSocket?.();
    this.closeSocket = null;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
  }
  reconnect() {
    if (!this.lifetime || this.lifetime.signal.aborted) return;
    this.attempts = 0;
    this.connect();
  }
  private connect() {
    const room = this.store.get().room;
    if (!room || !this.lifetime) return;
    this.stopSocket();
    const epoch = this.socketEpoch;
    this.presenceSequence = 0;
    this.store.update({
      connection: "connecting",
      online: null,
      interactionRevision: this.store.get().interactionRevision + 1,
    });
    const current = () => this.lifetime !== null && epoch === this.socketEpoch;
    this.watchdog = setTimeout(() => {
      if (current()) this.disconnected();
    }, 10_000);
    this.closeSocket = this.realtime.connect(room.snapshot.gameId, {
      message: (message) => {
        if (current()) this.message(message);
      },
      disconnected: () => {
        if (current()) this.disconnected();
      },
    });
  }
  private disconnected() {
    if (!this.lifetime) return;
    this.stopSocket();
    const delay = reconnectDelays[this.attempts++];
    this.store.update({
      connection: delay === undefined ? "failed" : "reconnecting",
      online: null,
      interactionRevision: this.store.get().interactionRevision + 1,
    });
    if (delay !== undefined) this.timer = setTimeout(() => this.connect(), delay);
  }
  private message(message: RoomServerMessage) {
    const room = this.store.get().room;
    if (!room) return;
    if (message.type === "access_lost") {
      this.loseAccess(new ApiFailure("api", "UNAUTHORIZED"));
      return;
    }
    if (message.type === "error") {
      this.disconnected();
      return;
    }
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.disconnected(), 45_000);
    if (message.type === "snapshot" || message.type === "update") {
      if (message.room.snapshot.gameId !== room.snapshot.gameId) {
        this.disconnected();
        return;
      }
      // Only a full baseline on this connection can re-enable commands.
      if (this.store.get().connection !== "synchronized" && message.type !== "snapshot") {
        this.disconnected();
        return;
      }
      const accepted = this.accept(message.room);
      if (!accepted) {
        if (this.store.get().connection !== "synchronized") this.disconnected();
        return;
      }
      this.attempts = 0;
      this.store.update({ connection: "synchronized" });
    } else if (message.gameId !== room.snapshot.gameId) {
      this.disconnected();
    } else if (message.type === "revision") {
      if (
        this.store.get().connection !== "synchronized" ||
        message.version !== room.snapshot.version
      ) {
        this.disconnected();
      }
    } else if (
      this.store.get().connection === "synchronized" &&
      message.sequence > this.presenceSequence
    ) {
      this.presenceSequence = message.sequence;
      this.store.update({ online: message.online });
    }
  }
  private accept(room: RoomView) {
    if (!this.store.accept(room)) return false;
    this.reconcileMove();
    if (
      isTerminal(room.snapshot) &&
      !this.store.get().replay &&
      this.store.get().replayPhase === "idle"
    ) {
      void this.archive.loadReplay();
    }
    return true;
  }
  private acceptSnapshot(snapshot: GameSnapshot) {
    if (this.store.acceptSnapshot(snapshot)) {
      this.reconcileMove();
      if (isTerminal(snapshot)) void this.archive.loadReplay();
    }
  }
  private reconcileMove() {
    const { room, pendingMove } = this.store.get();
    // Any accepted newer revision fences a still-in-flight command's expectedVersion.
    if (room && pendingMove && room.snapshot.version > pendingMove.expectedVersion) {
      this.store.update({ pendingMove: null, issue: null });
    }
  }
  async move(uci: string) {
    const state = this.store.get();
    if (!state.canMove || !state.room?.snapshot.legalMoves.includes(uci)) return;
    const command: MoveCommand = {
      gameId: state.room.snapshot.gameId,
      commandId: crypto.randomUUID(),
      expectedVersion: state.room.snapshot.version,
      move: uci,
    };
    this.store.update({ pendingMove: command });
    await this.sendMove(command);
  }
  async retryMove() {
    const state = this.store.get();
    if (!state.pendingMove || state.busy || state.connection !== "synchronized") return;
    await this.sendMove(state.pendingMove);
  }
  private async sendMove(command: MoveCommand) {
    await this.command(async (signal) => {
      const snapshot = await this.api.move(command, signal);
      if (signal.aborted) return;
      this.acceptSnapshot(snapshot);
      this.store.update({ pendingMove: null, issue: null });
    }, true);
  }
  async lifecycle(action: "resign" | "abort", expectedVersion: number) {
    const state = this.store.get();
    const room = state.room;
    if (
      !room ||
      !this.canCommand(expectedVersion) ||
      !(action === "abort" ? room.capabilities.canClose : room.capabilities.canResign)
    ) {
      return;
    }
    const command = {
      gameId: room.snapshot.gameId,
      commandId: crypto.randomUUID(),
      expectedVersion,
      ...(action === "resign"
        ? ({ action, losingColor: room.viewer.color } as const)
        : ({ action } as const)),
    };
    await this.command(async (signal) => {
      const snapshot = await this.api.lifecycle(command, signal);
      if (!signal.aborted) this.acceptSnapshot(snapshot);
    });
  }
  async invitation(action: "replace" | "revoke", expectedVersion: number) {
    const room = this.store.get().room;
    if (!room || !room.capabilities.canManageInvitation || !this.canCommand(expectedVersion)) {
      return;
    }
    this.store.update({ invitation: null });
    await this.command(async (signal) => {
      const issued = await this.api.invitation(
        { gameId: room.snapshot.gameId, commandId: crypto.randomUUID(), expectedVersion, action },
        signal,
      );
      if (signal.aborted) return;
      if (
        this.accept(issued.room) &&
        issued.room.state === "waiting" &&
        !isTerminal(issued.room.snapshot)
      ) {
        this.store.update({ invitation: issued.invitation });
      }
    });
  }
  private canCommand(version: number) {
    const state = this.store.get();
    return (
      state.connection === "synchronized" &&
      !state.busy &&
      !state.pendingMove &&
      state.room?.snapshot.version === version &&
      !isTerminal(state.room.snapshot)
    );
  }
  private async command(run: (signal: AbortSignal) => Promise<void>, move = false) {
    const lifetime = this.lifetime;
    if (!lifetime || this.store.get().busy) return;
    this.store.update({
      busy: true,
      issue: null,
      interactionRevision: this.store.get().interactionRevision + 1,
    });
    try {
      await run(lifetime.signal);
    } catch (error) {
      if (lifetime.signal.aborted || this.loseAccess(error)) return;
      if (error instanceof ApiFailure && error.currentSnapshot) {
        this.acceptSnapshot(error.currentSnapshot);
      }
      const rejected =
        error instanceof ApiFailure &&
        error.kind === "api" &&
        error.code !== "INTERNAL_SERVER_ERROR";
      if (rejected) this.store.update({ pendingMove: null, issue: "synchronize" });
      else if (error instanceof RequestRateLimitFailure) {
        this.store.update({ issue: "rateLimited" });
      } else {
        this.store.update({ issue: move && !this.store.get().pendingMove ? null : "uncertain" });
      }
      if (!move || rejected) this.reconnect();
    } finally {
      if (!lifetime.signal.aborted) this.store.update({ busy: false });
    }
  }
  private loseAccess(error: unknown) {
    if (!isAccessFailure(error)) return false;
    this.revokeAccess();
    return true;
  }
  revokeAccess() {
    this.endLifetime();
    this.store.clear("access");
  }
  unavailable() {
    this.endLifetime();
    this.store.clear("failed");
    this.store.update({ issue: "unavailable" });
  }
  readonly loadReplay = () => this.archive.loadReplay();
  readonly selectPly = (ply: number) => this.archive.selectPly(ply);
  readonly exportPgn = (action: "copy" | "download") => this.archive.exportPgn(action);
}
