import type { ChessColor, MoveCommand, RoomView } from "@neurochess/contracts";

import type { ArchiveState } from "../gameplay/archive-state";

export type RoomConnection =
  "connecting" | "synchronized" | "reconnecting" | "failed" | "access" | "stopped";
export interface RoomFlow {
  readonly room: RoomView | null;
  readonly connection: RoomConnection;
  readonly online: Readonly<Record<ChessColor, boolean>> | null;
  readonly busy: boolean;
  readonly pendingMove: MoveCommand | null;
  readonly issue: "uncertain" | "synchronize" | "unavailable" | null;
  readonly invitation: string | null;
  readonly interactionRevision: number;
}
export type RoomState = RoomFlow & ArchiveState & { readonly canMove: boolean };
