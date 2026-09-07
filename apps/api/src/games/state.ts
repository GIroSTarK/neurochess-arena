import { type ChessGame, type ChessSnapshot, restoreGame } from "@neurochess/chess";
import { gameLifecycleSchema, type GameSnapshot, gameSnapshotSchema } from "@neurochess/contracts";
import type { GameReader, StoredGame, StoredMove, StoredParticipant } from "@neurochess/database";

import type { GuestPrincipal } from "../guests/service.js";

import { authorizeGameRead } from "./authorization.js";
import { GameIntegrityError } from "./errors.js";
import { withInvocations } from "./telemetry.js";

interface RestoredGame {
  readonly game: ChessGame;
  readonly snapshot: GameSnapshot;
  readonly moves: StoredMove[];
  readonly participants: StoredParticipant[];
}

export async function restoreAuthorized(
  reader: GameReader,
  principal: GuestPrincipal,
  stored: StoredGame,
  sandboxEnabled: boolean,
): Promise<RestoredGame> {
  const participants = await reader.getParticipants(stored.id);
  // Never reconstruct or disclose a private position before establishing access.
  authorizeGameRead(principal, stored, participants, sandboxEnabled);
  if (participants.length !== 2 || new Set(participants.map((seat) => seat.color)).size !== 2) {
    throw new GameIntegrityError();
  }
  const moves = await reader.getMoves(stored.id);
  const lifecycle = gameLifecycleSchema.safeParse({
    state: stored.state,
    result: stored.result,
    terminationReason: stored.terminationReason,
  });
  if (!lifecycle.success) throw new GameIntegrityError();
  const restored = restoreGame({
    moves: moves.map((move) => move.uci),
    lifecycle: lifecycle.data,
  });
  if (!restored.ok) throw new GameIntegrityError();
  const domain = restored.value.snapshot();
  if (domain.fen !== stored.fen || domain.pgn !== stored.pgn) throw new GameIntegrityError();
  let previousVersion = 0;
  for (const [index, move] of moves.entries()) {
    const replayed = domain.moves[index];
    if (
      replayed?.ply !== move.ply ||
      replayed.san !== move.san ||
      replayed.fen !== move.fen ||
      !Number.isSafeInteger(move.version) ||
      move.version <= previousVersion ||
      move.version > stored.version
    ) {
      throw new GameIntegrityError();
    }
    previousVersion = move.version;
  }
  const position = transportSnapshot(stored.id, stored.version, domain);
  const snapshot =
    stored.mode === "human_vs_human" ? position : await withInvocations(reader, position, moves);
  return { game: restored.value, snapshot, moves, participants };
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
