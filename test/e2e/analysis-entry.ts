import { createGame } from "@neurochess/chess";

import { historyDigest, PROFILE_ID } from "../../apps/web/src/analysis/protocol";
import { AnalysisWorkerClient } from "../../apps/web/src/analysis/worker-client";

const client = new AnalysisWorkerClient();

export async function analyze(moves: string[]) {
  const game = createGame();
  game.start();
  for (const move of moves) {
    if (!game.playMove(move).ok) throw new Error("Invalid fixture history");
  }
  return client.analyze({
    lifetime: "production-smoke",
    gameId: "f0cfe67b-38a0-4e83-aec4-96c81ef479b7",
    ply: moves.length,
    moves,
    fen: game.snapshot().fen,
    historyDigest: await historyDigest(moves),
    profileId: PROFILE_ID,
  });
}

export function retry() {
  client.retry();
}
export function dispose() {
  client.dispose();
}
