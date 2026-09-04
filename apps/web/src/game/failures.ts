import type { GameErrorCode } from "@neurochess/contracts";

import { ApiFailure } from "../api/client";

import type { SandboxNotice } from "./state";

/** Codes that end the guest's access to the loaded game. */
export const accessCodes = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
] as const satisfies readonly GameErrorCode[];

/** Codes that reject a command outright; the accepted position is re-read before another. */
export const rejectionCodes = [
  "INVALID_REQUEST",
  "INVALID_UCI",
  "ILLEGAL_MOVE",
  "INVALID_GAME_STATE",
] as const satisfies readonly GameErrorCode[];

export type AccessCode = (typeof accessCodes)[number];
export type RejectionCode = (typeof rejectionCodes)[number];

export function isAccessCode(code: unknown): code is AccessCode {
  return accessCodes.some((candidate) => candidate === code);
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

export function failureNotice(failure: ApiFailure): SandboxNotice {
  return (
    failure.code ??
    (failure.kind === "api" || failure.kind === "cancelled" ? "network" : failure.kind)
  );
}
