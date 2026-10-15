import type { GameErrorCode } from "@neurochess/contracts";

import { ApiFailure } from "../api/failures";

/** Codes that end the current identity's access to the loaded game. */
const accessCodes = [
  "UNAUTHORIZED",
  "PROFILE_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
] as const satisfies readonly GameErrorCode[];

/** Codes that reject a command outright; the accepted position is re-read before another. */
const rejectionCodes = [
  "INVALID_REQUEST",
  "INVALID_UCI",
  "ILLEGAL_MOVE",
  "INVALID_GAME_STATE",
] as const satisfies readonly GameErrorCode[];

export type AccessCode = (typeof accessCodes)[number];
export type RejectionCode = (typeof rejectionCodes)[number];
export type FailureNotice = GameErrorCode | "network" | "timeout" | "malformed" | "rate_limited";

export function isAccessCode(code: unknown): code is AccessCode {
  return accessCodes.some((candidate) => candidate === code);
}

export function isAccessFailure(error: unknown): error is ApiFailure & { code: AccessCode } {
  return error instanceof ApiFailure && isAccessCode(error.code);
}

export function isRejectionCode(code: unknown): code is RejectionCode {
  return rejectionCodes.some((candidate) => candidate === code);
}

/** Only `ApiFailure` crosses the transport boundary; anything else counts as a network failure. */
export function safeFailure(error: unknown): ApiFailure {
  return error instanceof ApiFailure ? error : new ApiFailure("network");
}

export function rejectionOf(failure: ApiFailure): RejectionCode | undefined {
  return isRejectionCode(failure.code) ? failure.code : undefined;
}

export function failureNotice(failure: ApiFailure): FailureNotice {
  return (
    failure.code ??
    (failure.kind === "api" || failure.kind === "cancelled" ? "network" : failure.kind)
  );
}
