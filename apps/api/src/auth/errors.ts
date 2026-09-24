import type { AuthErrorCode } from "@neurochess/contracts";
import { isAPIError } from "better-auth/api";

export class AuthRequestError extends Error {
  constructor(readonly statusCode: number) {
    super("AUTH_REQUEST_FAILED");
    this.name = "AuthRequestError";
  }
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
