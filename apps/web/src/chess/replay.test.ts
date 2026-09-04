import { gameReplayResponseSchema } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { FOOLS_MATE, snapshot } from "../test/fixtures";

import { replayView } from "./replay";

describe("replay board presentation", () => {
  it("shows the initial position and each accepted position with the correct check/last move markers", () => {
    const final = snapshot(FOOLS_MATE);
    const replay = gameReplayResponseSchema.parse({ snapshot: final, initialFen: snapshot().fen });
    const before = structuredClone(replay);
    expect(replayView(replay, 0)).toEqual({
      fen: snapshot().fen,
      turn: "white",
      inCheck: false,
      lastMove: undefined,
    });
    for (let ply = 1; ply <= FOOLS_MATE.length; ply += 1) {
      const expected = snapshot(FOOLS_MATE.slice(0, ply));
      expect(replayView(replay, ply)).toEqual({
        fen: expected.fen,
        turn: expected.turn,
        inCheck: expected.inCheck,
        lastMove: FOOLS_MATE[ply - 1],
      });
    }
    expect(replayView(replay, -1)).toBeUndefined();
    expect(replayView(replay, 5)).toBeUndefined();
    expect(replay).toEqual(before);
  });
});
