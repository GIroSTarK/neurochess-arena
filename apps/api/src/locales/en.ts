import type { GameErrorCode } from "@neurochess/contracts";

// English is the initial API locale. Keep display text out of contracts and domain code.
export const gameErrorMessages: Readonly<Record<GameErrorCode, string>> = {
  INVALID_REQUEST: "The request could not be accepted.",
  INVALID_UCI: "The move notation is invalid.",
  ILLEGAL_MOVE: "The move is not legal in the current position.",
  INVALID_GAME_STATE: "The game cannot accept a move in its current state.",
  GAME_CONFLICT: "The game has changed. Use the current snapshot.",
  UNAUTHORIZED: "A valid guest session is required.",
  FORBIDDEN: "This action is not allowed.",
  NOT_FOUND: "The requested resource was not found.",
  INTERNAL_SERVER_ERROR: "The server could not complete the request.",
};
