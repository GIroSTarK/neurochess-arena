import type { GameErrorCode, GameSnapshot } from "@neurochess/contracts";

export type ApiFailureKind = "api" | "network" | "timeout" | "malformed" | "cancelled";

/** Only safe codes and validated snapshots survive the transport boundary. */
export class ApiFailure extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    readonly code?: GameErrorCode,
    readonly currentSnapshot?: GameSnapshot,
  ) {
    super(kind);
    this.name = "ApiFailure";
  }
}
