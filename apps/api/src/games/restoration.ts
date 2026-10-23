import { type ChessGame, restoreGame } from "@neurochess/chess";
import {
  type GameConfiguration,
  gameLifecycleSchema,
  type GameSnapshot,
} from "@neurochess/contracts";
import type {
  GameStateReader,
  RoomReader,
  StoredGame,
  StoredMove,
  StoredParticipant,
} from "@neurochess/database";

import type { GameIdentity } from "../identity/principal.js";

import { authorizeGameRead } from "./authorization.js";
import { transportSnapshot } from "./command-persistence.js";
import { configurationOf } from "./configuration.js";
import { GameIntegrityError } from "./errors.js";

export interface RestoredGame {
  readonly game: ChessGame;
  readonly snapshot: GameSnapshot;
  readonly moves: StoredMove[];
  readonly participants: StoredParticipant[];
  readonly configuration: GameConfiguration | null;
}

export type GameRestorationReader = Pick<GameStateReader, "getParticipants" | "getMoves"> &
  Pick<RoomReader, "hasRetainedRoomAccess" | "getRoom">;

export async function restoreAuthorizedGame(
  reader: GameRestorationReader,
  principal: GameIdentity,
  stored: StoredGame,
  sandboxEnabled: boolean,
): Promise<RestoredGame> {
  const participants = await reader.getParticipants(stored.id);
  // Never reconstruct or disclose a private position before establishing access.
  authorizeGameRead(
    principal,
    stored,
    participants,
    sandboxEnabled,
    stored.mode === "human_vs_human" && principal.kind === "account"
      ? await reader.hasRetainedRoomAccess(stored.id, principal.userId)
      : false,
  );
  if (participants.length !== 2 || new Set(participants.map((seat) => seat.color)).size !== 2) {
    throw new GameIntegrityError();
  }
  const room = stored.mode === "human_vs_human" ? await reader.getRoom(stored.id) : undefined;
  const configuration = configurationOf(stored, participants, room);
  const moves = await reader.getMoves(stored.id);
  if (room?.state === "waiting" && moves.length !== 0) throw new GameIntegrityError();
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
  const snapshot = transportSnapshot(stored.id, stored.version, domain);
  return { game: restored.value, snapshot, moves, participants, configuration };
}
