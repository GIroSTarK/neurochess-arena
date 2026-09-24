import type { AuthErrorCode, GameErrorCode } from "@neurochess/contracts";

export const authErrorMessages: Readonly<Record<AuthErrorCode, string>> = {
  AUTH_UNAUTHORIZED: "A valid account session is required.",
  AUTH_FORBIDDEN: "This authentication request is not allowed.",
  AUTH_INVALID_REQUEST: "The authentication request could not be accepted.",
  AUTH_NOT_FOUND: "This authentication operation is unavailable.",
  AUTH_RATE_LIMITED: "Too many authentication requests. Please try again later.",
  AUTH_UNAVAILABLE: "Authentication is temporarily unavailable. Please try again.",
};

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
