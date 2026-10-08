import type { GameSnapshot } from "@neurochess/contracts";

import type { AiApi } from "../api/ai-client";

import type { MatchStore } from "./store";

export interface MatchContext {
  readonly api: AiApi;
  readonly store: MatchStore;
  readonly signal: () => AbortSignal | null;
  readonly live: (signal: AbortSignal) => boolean;
  readonly adopt: (snapshot: GameSnapshot) => void;
  readonly fail: (error: unknown) => void;
  readonly accessLost: (error: unknown) => boolean;
}

export function matchCommand(store: MatchStore) {
  const snapshot = store.snapshot();
  return {
    gameId: snapshot.gameId,
    expectedVersion: snapshot.version,
    commandId: crypto.randomUUID(),
  };
}
