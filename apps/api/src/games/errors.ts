import type { AiRequestErrorCode, GameErrorCode, GameSnapshot } from "@neurochess/contracts";

export class AiTurnError extends Error {
  constructor(readonly code: AiRequestErrorCode) {
    super(code);
    this.name = "AiTurnError";
  }
}

export class GameRequestError extends Error {
  constructor(readonly code: Exclude<GameErrorCode, "GAME_CONFLICT">) {
    super(code);
    this.name = "GameRequestError";
  }
}

export class GameConflictError extends Error {
  readonly code = "GAME_CONFLICT";

  constructor(readonly currentSnapshot: GameSnapshot) {
    super("GAME_CONFLICT");
    this.name = "GameConflictError";
  }
}

export class GameIntegrityError extends Error {
  readonly code = "GAME_INTEGRITY";

  constructor() {
    super("Persisted game failed verification");
    this.name = "GameIntegrityError";
  }
}
