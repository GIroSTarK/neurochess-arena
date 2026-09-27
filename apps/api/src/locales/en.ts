import type {
  AuthErrorCode,
  CredentialErrorCode,
  GameErrorCode,
  ProfileErrorCode,
} from "@neurochess/contracts";

export const credentialErrorMessages: Readonly<Record<CredentialErrorCode, string>> = {
  CREDENTIAL_UNAUTHORIZED: "A valid account session is required.",
  CREDENTIAL_FORBIDDEN: "This credential request is not allowed.",
  CREDENTIAL_INVALID_REQUEST: "The credential request could not be accepted.",
  CREDENTIAL_NOT_FOUND: "The saved credential was not found.",
  CREDENTIAL_STORAGE_DISABLED:
    "Saving credentials is temporarily unavailable. Use a session-only key.",
  CREDENTIAL_UNAVAILABLE: "Your credentials are temporarily unavailable. Please try again.",
};

export const profileErrorMessages: Readonly<Record<ProfileErrorCode, string>> = {
  PROFILE_UNAUTHORIZED: "A valid account session is required.",
  PROFILE_FORBIDDEN: "This profile request is not allowed.",
  PROFILE_INVALID_REQUEST: "The profile request could not be accepted.",
  USERNAME_UNAVAILABLE: "This username is already in use. Choose another username.",
  AVATAR_UNAVAILABLE: "No supported provider avatar is available. Use initials instead.",
  PROFILE_UNAVAILABLE: "Your profile is temporarily unavailable. Please try again.",
};

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
  AUTH_OAUTH_FAILED:
    "Provider sign-in could not be completed. Please try again with a verified email.",
  AUTH_OAUTH_CONFLICT:
    "Sign in using your existing method, then explicitly link this provider with the same verified email.",
  AUTH_REAUTHENTICATION_REQUIRED: "Sign in again, then confirm the action from that account.",
  AUTH_ACCOUNT_CHANGED:
    "The signed-in account changed. Check your session before confirming again.",
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
  UNAUTHORIZED: "A valid session is required.",
  FORBIDDEN: "This action is not allowed.",
  PROFILE_REQUIRED: "Choose a username before starting an account game.",
  NOT_FOUND: "The requested resource was not found.",
  INTERNAL_SERVER_ERROR: "The server could not complete the request.",
};
