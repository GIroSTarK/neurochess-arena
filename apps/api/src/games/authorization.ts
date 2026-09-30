import type { ChessColor } from "@neurochess/chess";
import type { StoredGame, StoredParticipant } from "@neurochess/database";

import { isGuestPrincipal, type Principal } from "../identity/principal.js";

import { GameRequestError } from "./errors.js";

export function authorizeGameRead(
  principal: Principal,
  game: StoredGame,
  participants: readonly StoredParticipant[],
  sandboxEnabled: boolean,
): void {
  const isOwner = ownsGame(principal, game);
  const allowed = game.isSandbox
    ? sandboxEnabled && isOwner
    : isOwner || (game.mode === null && participants.some((seat) => occupiesSeat(principal, seat)));
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
  const sandboxControl = game.isSandbox && sandboxEnabled && ownsGame(principal, game);
  if (seat?.seatType !== "human" || (!sandboxControl && !occupiesSeat(principal, seat))) {
    throw new GameRequestError("FORBIDDEN");
  }
}

export function authorizeGameControl(principal: Principal, game: StoredGame): void {
  if (!ownsGame(principal, game)) {
    throw new GameRequestError("FORBIDDEN");
  }
}

function ownsGame(principal: Principal, game: StoredGame): boolean {
  return isGuestPrincipal(principal) && game.ownerGuestSessionId === principal.guestSessionId;
}

function occupiesSeat(principal: Principal, seat: StoredParticipant): boolean {
  return isGuestPrincipal(principal) && seat.guestSessionId === principal.guestSessionId;
}
