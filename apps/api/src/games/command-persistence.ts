import type { ChessSnapshot } from "@neurochess/chess";
import { type GameSnapshot, gameSnapshotSchema, isAiGameMode } from "@neurochess/contracts";
import type { GameTransaction, NewGameCommand, StoredGame } from "@neurochess/database";

import { GameIntegrityError } from "./errors.js";

export async function persistCommand(
  tx: GameTransaction,
  stored: StoredGame,
  commandId: string,
  kind: NewGameCommand["kind"],
  accepted: ChessSnapshot,
): Promise<GameSnapshot> {
  const snapshot = transportSnapshot(stored.id, stored.version + 1, accepted);
  await tx.appendCommand({ gameId: stored.id, commandId, version: snapshot.version, kind });
  if (kind === "move") {
    const move = snapshot.moves.at(-1);
    if (!move) throw new GameIntegrityError();
    await tx.appendMove({ ...move, gameId: stored.id, commandId, version: snapshot.version });
  }
  if (!(await tx.updatePosition(stored.id, stored.version, positionOf(snapshot)))) {
    throw new GameIntegrityError();
  }
  if (isAiGameMode(stored.mode)) {
    await tx.clearAiTurn(stored.id);
    if (snapshot.state === "completed" || snapshot.state === "aborted") {
      await tx.clearAiController(stored.id);
    }
  }
  return snapshot;
}

export function transportSnapshot(
  gameId: string,
  version: number,
  snapshot: ChessSnapshot,
): GameSnapshot {
  const result = gameSnapshotSchema.safeParse({ ...snapshot, gameId, version });
  if (!result.success) throw new GameIntegrityError();
  return result.data;
}

export function positionOf(snapshot: GameSnapshot) {
  return {
    state: snapshot.state,
    result: snapshot.result,
    terminationReason: snapshot.terminationReason,
    fen: snapshot.fen,
    pgn: snapshot.pgn,
    version: snapshot.version,
  };
}
