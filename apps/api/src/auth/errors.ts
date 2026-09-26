import type { AuthErrorCode } from "@neurochess/contracts";
import { isAPIError } from "better-auth/api";

export class AuthRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: AuthErrorCode = authErrorCode(statusCode),
  ) {
    super("AUTH_REQUEST_FAILED");
    this.name = "AuthRequestError";
  }
}

export function authFailureCode(error: unknown): AuthErrorCode {
  if (error instanceof AuthRequestError) return error.code;
  if (isAPIError(error)) return libraryAuthErrorCode(error.statusCode, error.body);
  return authErrorCode(authErrorStatus(error));
}

export function libraryAuthErrorCode(status: number, body: unknown): AuthErrorCode {
  const code = body && typeof body === "object" && "code" in body ? body.code : undefined;
  if (code === "EMAIL_NOT_VERIFIED") return "AUTH_EMAIL_NOT_VERIFIED";
  if (code === "INVALID_EMAIL_OR_PASSWORD") return "AUTH_INVALID_CREDENTIALS";
  if (code === "INVALID_TOKEN" || code === "TOKEN_EXPIRED") return "AUTH_INVALID_TOKEN";
  if (code === "AUTH_REAUTHENTICATION_REQUIRED") return "AUTH_REAUTHENTICATION_REQUIRED";
  if (code === "AUTH_ACCOUNT_CHANGED") return "AUTH_ACCOUNT_CHANGED";
  return authErrorCode(status);
}

export function authErrorStatus(error: unknown): number {
  if (error instanceof AuthRequestError || isAPIError(error)) return error.statusCode;
  return 500;
}

export function authErrorCode(status: number): AuthErrorCode {
  if (status === 401) return "AUTH_UNAUTHORIZED";
  if (status === 403) return "AUTH_FORBIDDEN";
  if (status === 404 || status === 405) return "AUTH_NOT_FOUND";
  if (status === 429) return "AUTH_RATE_LIMITED";
  return status >= 500 ? "AUTH_UNAVAILABLE" : "AUTH_INVALID_REQUEST";
}
