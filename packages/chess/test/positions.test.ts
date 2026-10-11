import { describe, expect, it } from "vitest";

import { replayPositions } from "../src/index.js";

describe("canonical position iteration", () => {
  it("yields the initial position and each accepted prefix without full game projections", () => {
    const positions = [...replayPositions(["f2f3", "e7e5", "g2g4", "d8h4"])];
    expect(positions).toHaveLength(5);
    expect(positions[0]).toEqual({
      ok: true,
      value: {
        ply: 0,
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        turn: "white",
        terminationReason: null,
      },
    });
    expect(positions.at(-1)).toEqual({
      ok: true,
      value: {
        ply: 4,
        fen: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
        turn: "white",
        terminationReason: "checkmate",
      },
    });
  });

  it("rejects illegal moves and moves after an automatically adjudicated draw", () => {
    expect([...replayPositions(["e2e5"])]).toHaveLength(2);
    expect([...replayPositions(["e2e5"])].at(-1)).toEqual({
      ok: false,
      error: { code: "INVALID_HISTORY", ply: 1 },
    });
    const repeated = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"];
    expect([...replayPositions(repeated)].at(-1)).toMatchObject({
      ok: true,
      value: { ply: 8, terminationReason: "threefold_repetition" },
    });
    expect([...replayPositions([...repeated, "e2e4"])].at(-1)).toEqual({
      ok: false,
      error: { code: "INVALID_HISTORY", ply: 9 },
    });
  });

  it("cannot accept an arbitrary starting position or malformed history", () => {
    expect([...replayPositions({ fen: "private" } as unknown as string[])]).toEqual([
      { ok: false, error: { code: "INVALID_HISTORY" } },
    ]);
  });
});
