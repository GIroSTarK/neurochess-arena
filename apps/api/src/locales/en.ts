import type { AuthErrorCode, GameErrorCode } from "@neurochess/contracts";

export const authErrorMessages: Readonly<Record<AuthErrorCode, string>> = {
  AUTH_UNAUTHORIZED: "A valid account session is required.",
  AUTH_FORBIDDEN: "This authentication request is not allowed.",
  AUTH_INVALID_REQUEST: "The authentication request could not be accepted.",
  AUTH_NOT_FOUND: "This authentication operation is unavailable.",
  AUTH_RATE_LIMITED: "Too many authentication requests. Please try again later.",
  AUTH_UNAVAILABLE: "Authentication is temporarily unavailable. Please try again.",
  AUTH_EMAIL_UNAVAILABLE: "Email delivery could not be confirmed. Please try again later.",
  AUTH_EMAIL_NOT_VERIFIED:
    "Verify your email before signing in. You can request another verification email.",
  AUTH_INVALID_CREDENTIALS: "The email or password is incorrect.",
  AUTH_INVALID_TOKEN: "This link is invalid or has expired. Please request a new link.",
};

export const authEmailMessages = {
  verification: {
    subject: "Verify your Neurochess Arena email",
    text: (url: string) =>
      `Verify your email address to sign in to Neurochess Arena:\n\n${url}\n\nThis link expires in one hour. If you did not request this, ignore this email.`,
  },
  reset: {
    subject: "Reset your Neurochess Arena password",
    text: (url: string) =>
      `If you have a Neurochess Arena account for this address, use this link to choose a new password:\n\n${url}\n\nFor an existing account, this link expires in one hour and can be used once. Resetting your password signs out all your sessions. If you did not request this, ignore this email.`,
  },
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
