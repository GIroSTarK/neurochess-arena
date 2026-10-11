import { createHash } from "node:crypto";

import type { GameSnapshot } from "@neurochess/contracts";

export function analysisSample(snapshot: GameSnapshot, ply = 0) {
  return {
    ply,
    fen:
      ply === 0
        ? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        : snapshot.moves[ply - 1]!.fen,
    historyDigest: createHash("sha256")
      .update(JSON.stringify(["standard-v1", ...snapshot.moves.slice(0, ply).map((m) => m.uci)]))
      .digest("hex"),
    profileId: "sf19-lite-single-v1",
    depth: 12,
    durationMs: 900,
    score: { kind: "cp" as const, value: 24 },
  };
}
