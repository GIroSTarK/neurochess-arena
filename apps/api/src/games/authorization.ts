import type { ChessColor } from "@neurochess/chess";
import type { StoredGame, StoredParticipant } from "@neurochess/database";

import type { GuestPrincipal } from "../guests/service.js";

import { GameRequestError } from "./errors.js";

export function authorizeGameRead(
  principal: GuestPrincipal,
  game: StoredGame,
  participants: readonly StoredParticipant[],
  sandboxEnabled: boolean,
): void {
  const isOwner = game.ownerGuestSessionId === principal.guestSessionId;
  const allowed = game.isSandbox
    ? sandboxEnabled && isOwner
    : isOwner || participants.some((seat) => seat.guestSessionId === principal.guestSessionId);
  if (!allowed) throw new GameRequestError("NOT_FOUND");
}

export function authorizeHumanMove(
  principal: GuestPrincipal,
  game: StoredGame,
  participants: readonly StoredParticipant[],
  turn: ChessColor,
  sandboxEnabled: boolean,
): void {
  authorizeGameRead(principal, game, participants, sandboxEnabled);
  const seat = participants.find((participant) => participant.color === turn);
  const sandboxControl =
    game.isSandbox && sandboxEnabled && game.ownerGuestSessionId === principal.guestSessionId;
  if (
    seat?.seatType !== "human" ||
    (!sandboxControl && seat.guestSessionId !== principal.guestSessionId)
  ) {
    throw new GameRequestError("FORBIDDEN");
  }
}
