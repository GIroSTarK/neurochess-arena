import type { GameSnapshot, RoomView } from "@neurochess/contracts";

import {
  type ArchiveFeedback,
  type ArchiveState,
  emptyExport,
  emptyReplay,
  type ExportState,
  type ReplayState,
} from "../gameplay/archive-state";
import { isTerminal, sameSnapshot } from "../gameplay/snapshot";

import type { RoomFlow, RoomState } from "./state";

const empty: RoomFlow = {
  room: null,
  connection: "stopped",
  online: null,
  busy: false,
  pendingMove: null,
  issue: null,
  invitation: null,
  interactionRevision: 0,
};

export class RoomStore {
  private flow: RoomFlow = { ...empty };
  private archive: ArchiveState = { ...emptyReplay, ...emptyExport };
  private state = this.project();
  private readonly listeners = new Set<() => void>();
  readonly get = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(update: Partial<RoomFlow>) {
    this.flow = { ...this.flow, ...update };
    this.publish();
  }
  accept(room: RoomView): boolean {
    const previous = this.flow.room?.snapshot;
    const next = room.snapshot;
    if (
      previous &&
      (previous.gameId !== next.gameId ||
        previous.version > next.version ||
        (previous.version === next.version && !sameSnapshot(previous, next)) ||
        (isTerminal(previous) && !isTerminal(next)))
    ) {
      return false;
    }
    if (previous?.version !== next.version) this.archive = { ...emptyReplay, ...emptyExport };
    this.update({
      room,
      ...(room.state !== "waiting" ||
      isTerminal(next) ||
      !room.invitationAvailable ||
      (previous && next.version > previous.version)
        ? { invitation: null }
        : {}),
    });
    return true;
  }
  acceptSnapshot(snapshot: GameSnapshot): boolean {
    const room = this.flow.room;
    if (!room || snapshot.version <= room.snapshot.version) return false;
    const terminal = isTerminal(snapshot);
    return this.accept({
      ...room,
      snapshot,
      invitationAvailable: !terminal && room.invitationAvailable,
      capabilities: {
        ...room.capabilities,
        canMove: !terminal && snapshot.state === "active" && snapshot.turn === room.viewer.color,
        canResign: !terminal && room.state === "joined",
        canClose: !terminal && room.viewer.isOwner,
        canManageInvitation: !terminal && room.state === "waiting" && room.viewer.isOwner,
      },
    });
  }
  readonly getArchive = () => ({ ...this.archive, snapshot: this.flow.room?.snapshot ?? null });
  readonly setReplay = (replay: ReplayState, feedback?: ArchiveFeedback) => {
    this.archive = { ...this.archive, ...replay };
    if (feedback?.invalidateInteraction) {
      this.flow = { ...this.flow, interactionRevision: this.flow.interactionRevision + 1 };
    }
    this.publish();
  };
  readonly setExport = (state: ExportState) => {
    this.archive = { ...this.archive, ...state };
    this.publish();
  };
  clear(connection: RoomFlow["connection"] = "stopped") {
    this.archive = { ...emptyReplay, ...emptyExport };
    this.flow = { ...empty, connection, interactionRevision: this.flow.interactionRevision + 1 };
    this.publish();
  }
  private project(): RoomState {
    const { room, connection, busy, pendingMove } = this.flow;
    return {
      ...this.flow,
      ...this.archive,
      canMove:
        !!room &&
        connection === "synchronized" &&
        !busy &&
        !pendingMove &&
        room.state === "joined" &&
        room.snapshot.state === "active" &&
        room.capabilities.canMove &&
        room.snapshot.turn === room.viewer.color,
    };
  }
  private publish() {
    this.state = this.project();
    this.listeners.forEach((listener) => listener());
  }
}
