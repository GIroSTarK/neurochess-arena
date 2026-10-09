import type { RoomView } from "@neurochess/contracts";

import { snapshot } from "./fixtures";

export const INVITATION = "A".repeat(43);
export const REPLACEMENT_INVITATION = "B".repeat(42) + "A";
export const roomSession = {
  user: {
    id: "1927fffc-81fa-40a2-ae6e-154d2867c05b",
    email: "room@example.com",
    emailVerified: true,
  },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
export const roomProfile = {
  username: "RoomPlayer",
  completed: true,
  avatar: { source: "initials", initials: "RP" },
};
export function waitingRoom(ownerColor: "white" | "black" = "white"): RoomView {
  return {
    snapshot: snapshot([], { state: "paused", legalMoves: [] }),
    ownerColor,
    state: "waiting",
    invitationAvailable: true,
    players: {
      white:
        ownerColor === "white"
          ? { kind: "account", username: "RoomPlayer" }
          : { kind: "unassigned" },
      black:
        ownerColor === "black"
          ? { kind: "account", username: "RoomPlayer" }
          : { kind: "unassigned" },
    },
    viewer: { color: ownerColor, isOwner: true },
    capabilities: { canMove: false, canResign: false, canClose: true, canManageInvitation: true },
  };
}
export function joinedRoom(): RoomView {
  return {
    ...waitingRoom("black"),
    state: "joined",
    invitationAvailable: false,
    snapshot: snapshot([], { version: 1 }),
    players: { white: { kind: "guest" }, black: { kind: "account", username: "RoomPlayer" } },
    viewer: { color: "white", isOwner: false },
    capabilities: { canMove: true, canResign: true, canClose: false, canManageInvitation: false },
  };
}
