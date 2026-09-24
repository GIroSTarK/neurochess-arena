import type { ChessColor } from "@neurochess/chess";
import type { StoredGame, StoredParticipant } from "@neurochess/database";

import type { GuestPrincipal as Principal } from "../identity/principal.js";

import { GameRequestError } from "./errors.js";

function isOwner(principal: Principal, game: StoredGame): boolean {
  return game.ownerGuestSessionId === principal.guestSessionId;
}

function isParticipant(principal: Principal, seat: StoredParticipant): boolean {
  return seat.guestSessionId === principal.guestSessionId;
}

export function authorizeGameRead(
  principal: Principal,
  game: StoredGame,
  participants: readonly StoredParticipant[],
  sandboxEnabled: boolean,
): void {
  const owner = isOwner(principal, game);
  const allowed = game.isSandbox
    ? sandboxEnabled && owner
    : owner || (game.mode === null && participants.some((seat) => isParticipant(principal, seat)));
  if (!allowed) throw new GameRequestError("NOT_FOUND");
}

export function authorizeHumanSeat(
  principal: Principal,
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

export function authorizeGameControl(principal: Principal, game: StoredGame): void {
  if (!isOwner(principal, game)) {
    throw new GameRequestError("FORBIDDEN");
  }
}
