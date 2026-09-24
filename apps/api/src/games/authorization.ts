import type { ChessColor } from "@neurochess/chess";
import type { GameOwner, StoredGame, StoredParticipant } from "@neurochess/database";

import { GameRequestError } from "./errors.js";

function isOwner(principal: GameOwner, game: StoredGame): boolean {
  return principal.kind === "guest"
    ? game.ownerGuestSessionId === principal.guestSessionId
    : game.ownerUserId === principal.userId;
}

function isParticipant(principal: GameOwner, seat: StoredParticipant): boolean {
  return principal.kind === "guest"
    ? seat.guestSessionId === principal.guestSessionId
    : seat.userId === principal.userId;
}

export function authorizeGameRead(
  principal: GameOwner,
  game: StoredGame,
  participants: readonly StoredParticipant[],
  sandboxEnabled: boolean,
): void {
  const owner = isOwner(principal, game);
  const allowed = game.isSandbox
    ? sandboxEnabled && principal.kind === "guest" && owner
    : owner || (game.mode === null && participants.some((seat) => isParticipant(principal, seat)));
  if (!allowed) throw new GameRequestError("NOT_FOUND");
}

export function authorizeHumanSeat(
  principal: GameOwner,
  game: StoredGame,
  participants: readonly StoredParticipant[],
  turn: ChessColor,
  sandboxEnabled: boolean,
): void {
  authorizeGameRead(principal, game, participants, sandboxEnabled);
  const seat = participants.find((participant) => participant.color === turn);
  const sandboxControl = game.isSandbox && sandboxEnabled && isOwner(principal, game);
  if (seat?.seatType !== "human" || (!sandboxControl && !isParticipant(principal, seat))) {
    throw new GameRequestError("FORBIDDEN");
  }
}

export function authorizeGameControl(principal: GameOwner, game: StoredGame): void {
  if (!isOwner(principal, game)) {
    throw new GameRequestError("FORBIDDEN");
  }
}
