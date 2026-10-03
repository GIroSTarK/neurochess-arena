import type { AuthErrorCode, GameErrorCode, ProfileErrorCode } from "@neurochess/contracts";

export const profileErrorMessages: Readonly<Record<ProfileErrorCode, string>> = {
  PROFILE_INVALID_REQUEST: "Choose a valid username or remove your provider avatar.",
  PROFILE_UNAUTHORIZED: "Sign in to view or change your profile.",
  PROFILE_FORBIDDEN: "This profile request is not allowed.",
  PROFILE_USERNAME_TAKEN: "That username is unavailable. Choose another name.",
  PROFILE_UNAVAILABLE: "Your profile is temporarily unavailable. Try again later.",
};

export const authErrorMessages: Readonly<Record<AuthErrorCode, string>> = {
  AUTH_INVALID_REQUEST: "The authentication request could not be accepted.",
  AUTH_UNAUTHORIZED: "A valid account session is required.",
  AUTH_REAUTH_REQUIRED: "Sign in again before deleting your account.",
  AUTH_FORBIDDEN: "This authentication request is not allowed.",
  AUTH_NOT_FOUND: "This authentication action is not available.",
  AUTH_RATE_LIMITED: "Too many authentication requests. Try again later.",
  AUTH_UNAVAILABLE: "Authentication is temporarily unavailable. Try again later.",
  AUTH_EMAIL_NOT_VERIFIED: "Verify your email before signing in. You can request a new link.",
  AUTH_INVALID_CREDENTIALS: "The email or password is incorrect.",
  AUTH_INVALID_TOKEN: "This link is invalid or has expired. Request a new link.",
  AUTH_OAUTH_FAILED: "Sign-in could not be completed. Start again with Google or GitHub.",
  AUTH_OAUTH_CANCELLED: "Sign-in was canceled. You can try again when ready.",
  AUTH_OAUTH_EMAIL_UNAVAILABLE:
    "This provider did not supply a valid verified email. Check your provider account or use your existing sign-in method.",
  AUTH_OAUTH_ACCOUNT_CONFLICT:
    "Use your existing sign-in method or password recovery. Accounts are not linked automatically.",
};

export const authEmailAcceptedMessage =
  "Your request was received. If no email arrives, wait a minute and request a new link.";

export const authEmailMessages = {
  verification: {
    subject: "Verify your Neurochess Arena email",
    text: (url: string) =>
      `Verify your email to sign in to Neurochess Arena:\n\n${url}\n\nThis link expires in one hour. If you did not request an account, you can ignore this email.`,
  },
  reset: {
    subject: "Reset your Neurochess Arena password",
    text: (url: string) =>
      `Choose a new Neurochess Arena password:\n\n${url}\n\nThis link expires in one hour and can be used once. Resetting your password signs out all existing sessions. If you did not request this, you can ignore this email.`,
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
  PROFILE_REQUIRED: "Choose a username to complete your profile before playing.",
  NOT_FOUND: "The requested resource was not found.",
  INTERNAL_SERVER_ERROR: "The server could not complete the request.",
};
export const credentialErrorMessages = {
  CREDENTIAL_INVALID_REQUEST: "Check the credential details and try again.",
  CREDENTIAL_UNAUTHORIZED: "Sign in again to manage saved keys.",
  CREDENTIAL_FORBIDDEN: "This credential request is not allowed.",
  CREDENTIAL_CONFLICT: "This save ID already exists. Refresh your saved keys before trying again.",
  CREDENTIAL_LIMIT_REACHED: "Revoke a saved key before saving another.",
  CREDENTIAL_UNAVAILABLE: "Saved key management is unavailable. Try again later.",
};
