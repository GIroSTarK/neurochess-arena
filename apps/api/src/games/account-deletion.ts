import { restoreGame } from "@neurochess/chess";
import { gameLifecycleSchema } from "@neurochess/contracts";
import type { AbortSharedGame } from "@neurochess/database";

import { positionOf, transportSnapshot } from "./command-persistence.js";
import { GameIntegrityError } from "./errors.js";

export const abortSharedGame: AbortSharedGame = (stored, moves) => {
  const restored = restoreGame({
    moves: moves.map((move) => move.uci),
    lifecycle: gameLifecycleSchema.parse({
      state: stored.state,
      result: stored.result,
      terminationReason: stored.terminationReason,
    }),
  });
  if (!restored.ok) throw new GameIntegrityError();
  const current = restored.value.snapshot();
  if (current.fen !== stored.fen || current.pgn !== stored.pgn) throw new GameIntegrityError();
  const aborted = restored.value.abort();
  if (!aborted.ok) throw new GameIntegrityError();
  return positionOf(transportSnapshot(stored.id, stored.version + 1, aborted.value));
};
