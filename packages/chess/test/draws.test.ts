import { describe, expect, it } from "vitest";

import { restoreGame } from "../src/index.js";

import {
  ACTIVE,
  activeGame,
  FIFTY_MOVE_HISTORY,
  INITIAL_FEN,
  KNIGHT_CYCLE,
  lifecycleOf,
  play,
  position,
  unwrap,
} from "./fixtures.js";

describe("automatic fifty-move draws", () => {
  it("restores a real standard-start history at 99 and preserves the draw at 100", () => {
    expect(FIFTY_MOVE_HISTORY).toHaveLength(100);
    const prefix = FIFTY_MOVE_HISTORY.slice(0, 99);
    const original = activeGame();
    play(original, prefix);
    const at99 = original.snapshot();
    expect(at99.state).toBe("active");
    expect(at99.fen.split(" ")[4]).toBe("99");

    const restored = unwrap(restoreGame({ moves: prefix, lifecycle: ACTIVE }));
    expect(restored.snapshot()).toEqual(at99);
    const at100 = unwrap(restored.playMove("e3c4"));
    expect(at100.terminationReason).toBe("fifty_move_rule");
    expect(at100.fen).toBe("1rbqkb1r/pppppppp/6nN/5N2/2n5/8/PPPPPPPP/R1BQKB1R w - - 100 51");
    expect(
      unwrap(
        restoreGame({ moves: FIFTY_MOVE_HISTORY, lifecycle: lifecycleOf(restored) }),
      ).snapshot(),
    ).toEqual(at100);
    expect(original.snapshot()).toEqual(at99);
  });

  it("keeps 99 half-moves active and completes on the 100th", () => {
    const game = position("7k/8/8/8/8/8/R7/K7 w - - 98 50");
    const at99 = unwrap(game.playMove("a2b2"));
    expect(at99.fen.split(" ")[4]).toBe("99");
    expect(at99.state).toBe("active");
    const at100 = unwrap(game.playMove("h8g8"));
    expect(at100.fen.split(" ")[4]).toBe("100");
    expect(at100).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "fifty_move_rule",
      legalMoves: [],
    });
    expect(at100.pgn).toContain('[Result "1/2-1/2"]');
    expect(at100.pgn).toMatch(/1\/2-1\/2$/);
    expect(game.playMove("b2c2")).toEqual({ ok: false, error: { code: "INVALID_GAME_STATE" } });
  });

  it.each([
    ["single pawn", "7k/8/8/8/8/8/P7/K7 w - - 99 50", "a2a3"],
    ["double pawn", "7k/8/8/8/8/8/P7/K7 w - - 99 50", "a2a4"],
    ["rook capture", "7k/8/8/8/8/r7/R7/K7 w - - 99 50", "a2a3"],
    ["pawn capture", "7k/8/8/8/8/1r6/P7/K7 w - - 99 50", "a2b3"],
    ["en passant", "7k/8/8/3pP3/8/8/8/K7 w - d6 99 50", "e5d6"],
    ["promotion", "7k/P7/8/8/8/8/8/K7 w - - 99 50", "a7a8q"],
    ["capture promotion", "1r5k/P7/8/8/8/8/8/K7 w - - 99 50", "a7b8q"],
    ["black pawn", "7k/7p/8/8/8/8/8/K7 b - - 99 50", "h7h6"],
  ])("resets the counter for %s", (_name, fen, move) => {
    const snapshot = unwrap(position(fen).playMove(move));
    expect(snapshot.fen.split(" ")[4]).toBe("0");
    expect(snapshot.state).toBe("active");
    expect(snapshot.terminationReason).toBeNull();
  });

  it("does not reset the counter for castling", () => {
    const snapshot = unwrap(position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 99 50").playMove("e1g1"));
    expect(snapshot.fen.split(" ")[4]).toBe("100");
    expect(snapshot.terminationReason).toBe("fifty_move_rule");
  });

  it("pause and resume preserve the half-move counter", () => {
    const game = position("7k/8/8/8/8/8/R7/K7 w - - 99 50");
    const before = game.snapshot();
    unwrap(game.pause());
    unwrap(game.resume());
    expect(game.snapshot()).toEqual(before);
    expect(unwrap(game.playMove("a2b2")).terminationReason).toBe("fifty_move_rule");
  });
});

describe("result precedence", () => {
  it("prioritizes checkmate delivered on the 100th half-move", () => {
    const snapshot = unwrap(position("7k/8/5KQ1/8/8/8/8/8 w - - 99 50").playMove("g6g7"));
    expect(snapshot.fen.split(" ")[4]).toBe("100");
    expect(snapshot).toMatchObject({ result: "1-0", terminationReason: "checkmate" });
    expect(snapshot.moves[0]?.san).toBe("Qg7#");
    expect(snapshot.pgn).toMatch(/Qg7# 1-0$/);
  });

  it("prioritizes stalemate over the fifty-move threshold", () => {
    const snapshot = unwrap(position("7k/8/5KQ1/8/8/8/8/8 w - - 99 50").playMove("g6f7"));
    expect(snapshot.fen.split(" ")[4]).toBe("100");
    expect(snapshot.terminationReason).toBe("stalemate");
  });

  it("prioritizes insufficient material over the fifty-move threshold", () => {
    expect(position("7k/8/8/8/8/8/B7/K7 w - - 100 51").snapshot().terminationReason).toBe(
      "insufficient_material",
    );
  });

  it("prioritizes repetition when its third occurrence reaches 100 half-moves", () => {
    const game = position(INITIAL_FEN.replace("0 1", "92 47"));
    play(game, [...KNIGHT_CYCLE, ...KNIGHT_CYCLE]);
    expect(game.snapshot().fen.split(" ")[4]).toBe("100");
    expect(game.snapshot().terminationReason).toBe("threefold_repetition");
  });
});

describe("automatic repetition draws", () => {
  it("counts the initial position and ends the documented sequence at ply eight", () => {
    const game = activeGame();
    play(game, KNIGHT_CYCLE);
    expect(game.snapshot().state).toBe("active");
    play(game, KNIGHT_CYCLE.slice(0, 3));
    expect(game.snapshot().state).toBe("active");
    const snapshot = unwrap(game.playMove("f6g8"));
    expect(snapshot).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "threefold_repetition",
      legalMoves: [],
    });
    expect(snapshot.moves).toHaveLength(8);
    expect(game.playMove("e2e4").ok).toBe(false);
  });

  it("preserves repetition across restoration and paused recovery", () => {
    const original = activeGame();
    play(original, KNIGHT_CYCLE);
    unwrap(original.pause());
    const restored = unwrap(
      restoreGame({
        moves: original.snapshot().moves.map((move) => move.uci),
        lifecycle: lifecycleOf(original),
      }),
    );
    expect(restored.snapshot()).toEqual(original.snapshot());
    unwrap(restored.resume());
    play(restored, KNIGHT_CYCLE);
    expect(restored.snapshot().terminationReason).toBe("threefold_repetition");
    expect(restored.snapshot().moves).toHaveLength(8);
  });

  it("counts nonconsecutive occurrences reached by different routes", () => {
    const game = activeGame();
    play(game, [...KNIGHT_CYCLE, "b1c3", "b8c6", "c3b1"]);
    expect(game.snapshot().state).toBe("active");
    expect(unwrap(game.playMove("c6b8")).terminationReason).toBe("threefold_repetition");
  });

  it("does not count queries, pause/resume, or rejected moves as occurrences", () => {
    const game = activeGame();
    for (let index = 0; index < 5; index += 1) {
      game.snapshot();
      game.playMove("e2e5");
      unwrap(game.pause());
      unwrap(game.resume());
    }
    play(game, KNIGHT_CYCLE);
    expect(game.snapshot().state).toBe("active");
    play(game, KNIGHT_CYCLE);
    expect(game.snapshot().terminationReason).toBe("threefold_repetition");
  });

  it("distinguishes otherwise equal positions with lost castling rights", () => {
    const game = position("4k1n1/8/8/8/8/8/8/4K1NR w K - 0 1");
    play(game, ["h1h2", "g8f6", "h2h1", "f6g8", ...KNIGHT_CYCLE]);
    expect(game.snapshot().state).toBe("active");
    // Without castling in the key the previous move would have ended the game.
    play(game, ["g1f3", "g8f6"]);
    expect(unwrap(game.playMove("f3g1")).terminationReason).toBe("threefold_repetition");
  });

  it("does not equate different sides to move", () => {
    const game = position("7k/8/8/8/8/8/R7/7K w - - 0 1");
    // Same placement at plies 0, 5 and 10, but Black is to move only at ply 5.
    play(game, ["a2b2", "h8g8", "b2c2", "g8h8", "c2a2", "h8g8", "a2b2", "g8g7", "b2a2", "g7h8"]);
    expect(game.snapshot().state).toBe("active");
  });

  it("distinguishes a genuinely legal en passant opportunity from its expiration", () => {
    const game = position("k5n1/3p4/8/4P3/8/8/8/4K1N1 b - - 0 1");
    unwrap(game.playMove("d7d5"));
    expect(game.snapshot().fen.split(" ")[3]).toBe("d6");
    play(game, [...KNIGHT_CYCLE, ...KNIGHT_CYCLE]);
    expect(game.snapshot().state).toBe("active");
    expect(unwrap(game.playMove("g1f3")).terminationReason).toBe("threefold_repetition");
  });

  it("ignores the unusable en passant target of a pinned pawn (chess.js 1.4.0 regression)", () => {
    const game = position("k3r1n1/3p4/8/4P3/8/8/8/4K1N1 b - - 0 1");
    unwrap(game.playMove("d7d5"));
    expect(game.snapshot().fen.split(" ")[3]).toBe("-");
    play(game, [...KNIGHT_CYCLE, ...KNIGHT_CYCLE]);
    expect(game.snapshot().terminationReason).toBe("threefold_repetition");
    expect(game.snapshot().moves).toHaveLength(9);
  });
});
