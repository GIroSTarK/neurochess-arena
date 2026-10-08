import type {
  GameDetails,
  GamePgnResponse,
  GameReplayResponse,
  GameSnapshot,
} from "@neurochess/contracts";

import { parsePosition } from "../position/position";

import { ApiFailure } from "./failures";

export function snapshotFor(snapshot: GameSnapshot, gameId?: string): GameSnapshot {
  if (
    parsePosition(snapshot.fen)?.turn !== snapshot.turn ||
    (gameId !== undefined && snapshot.gameId !== gameId)
  ) {
    throw new ApiFailure("malformed");
  }
  return snapshot;
}

export function detailsFor(details: GameDetails, gameId?: string): GameDetails {
  snapshotFor(details.snapshot, gameId);
  return details;
}

export function replayFor(replay: GameReplayResponse, gameId: string): GameReplayResponse {
  snapshotFor(replay.snapshot, gameId);
  if (
    !parsePosition(replay.initialFen) ||
    replay.snapshot.moves.some((move) => !parsePosition(move.fen))
  ) {
    throw new ApiFailure("malformed");
  }
  return replay;
}

export function pgnFor(pgn: GamePgnResponse, gameId: string): GamePgnResponse {
  if (pgn.gameId !== gameId) throw new ApiFailure("malformed");
  return pgn;
}
