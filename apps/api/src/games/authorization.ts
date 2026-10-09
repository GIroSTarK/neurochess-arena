import type { ChessColor } from "@neurochess/chess";
import type { StoredGame, StoredParticipant } from "@neurochess/database";

import { type GameIdentity, isGuestPrincipal } from "../identity/principal.js";

import { GameIntegrityError, GameRequestError } from "./errors.js";

export function authorizeGameRead(
  principal: GameIdentity,
  game: StoredGame,
  participants: readonly StoredParticipant[],
  sandboxEnabled: boolean,
): void {
  const isOwner = ownsGame(principal, game);
  const allowed = game.isSandbox
    ? sandboxEnabled && isOwner
    : isOwner ||
      ((game.mode === null || game.mode === "human_vs_human") &&
        participants.some((seat) => occupiesSeat(principal, seat)));
  if (!allowed) throw new GameRequestError("NOT_FOUND");
}

export function authorizeHumanSeat(
  principal: GameIdentity,
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

export function authorizeGameControl(principal: GameIdentity, game: StoredGame): void {
  if (!ownsGame(principal, game)) {
    throw new GameRequestError("FORBIDDEN");
  }
}

export function ownerOf(
  game: Pick<StoredGame, "ownerUserId" | "ownerGuestSessionId">,
): GameIdentity {
  if (game.ownerGuestSessionId && !game.ownerUserId) {
    return { kind: "guest", guestSessionId: game.ownerGuestSessionId };
  }
  if (game.ownerUserId && !game.ownerGuestSessionId) {
    return { kind: "account", userId: game.ownerUserId };
  }
  throw new GameIntegrityError();
}

function ownsGame(principal: GameIdentity, game: StoredGame): boolean {
  return isGuestPrincipal(principal)
    ? game.ownerGuestSessionId === principal.guestSessionId
    : !game.isSandbox && game.ownerUserId === principal.userId;
}

function occupiesSeat(principal: GameIdentity, seat: StoredParticipant): boolean {
  return isGuestPrincipal(principal)
    ? seat.guestSessionId === principal.guestSessionId
    : seat.userId === principal.userId;
}
