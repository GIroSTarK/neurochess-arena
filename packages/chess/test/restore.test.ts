import { Chess } from "chess.js";
import { describe, expect, it, vi } from "vitest";

import {
  createGame,
  type GameLifecycle,
  restoreGame,
  type RestoreGameInput,
} from "../src/index.js";
import { ChessRules } from "../src/rules.js";

import {
  ACTIVE,
  activeGame,
  FIFTY_MOVE_HISTORY,
  FOOLS_MATE,
  INITIAL_FEN,
  KNIGHT_CYCLE,
  lifecycleOf,
  play,
  unwrap,
} from "./fixtures.js";

const histories = [
  { name: "empty", moves: [] },
  { name: "castling", moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"] },
  { name: "en passant", moves: ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"] },
  {
    name: "both colors promoting",
    moves: ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2", "b7a8q", "g2h1n"],
  },
  { name: "checkmate", moves: FOOLS_MATE },
  { name: "repetition", moves: [...KNIGHT_CYCLE, ...KNIGHT_CYCLE] },
];

describe("history restoration and PGN", () => {
  it.each([
    { name: "configuring", moves: [], ending: "configuring" },
    { name: "active", moves: FIFTY_MOVE_HISTORY.slice(0, 99), ending: null },
    { name: "paused", moves: KNIGHT_CYCLE, ending: "pause" },
    { name: "aborted", moves: KNIGHT_CYCLE, ending: "abort" },
    { name: "human resignation", moves: KNIGHT_CYCLE, ending: "resignHuman" },
    { name: "technical loss", moves: KNIGHT_CYCLE, ending: "recordTechnicalLoss" },
    { name: "checkmate", moves: FOOLS_MATE, ending: null },
    { name: "repetition", moves: [...KNIGHT_CYCLE, ...KNIGHT_CYCLE], ending: null },
    { name: "fifty-move draw", moves: FIFTY_MOVE_HISTORY, ending: null },
  ] as const)("defers snapshot projection while restoring $name history", ({ moves, ending }) => {
    const original = ending === "configuring" ? createGame() : activeGame();
    play(original, moves);
    if (ending !== null && ending !== "configuring") {
      unwrap(
        ending === "resignHuman" || ending === "recordTechnicalLoss"
          ? original[ending]("black")
          : original[ending](),
      );
    }
    const expected = original.snapshot();
    const lifecycle = lifecycleOf(original);
    const pgn = vi.spyOn(ChessRules.prototype, "pgn");
    const legalMoves = vi.spyOn(ChessRules.prototype, "legalMoves");
    try {
      const restored = unwrap(restoreGame({ moves, lifecycle }));
      expect(pgn).not.toHaveBeenCalled();
      expect(legalMoves).not.toHaveBeenCalled();

      expect(restored.snapshot()).toEqual(expected);
      expect(pgn).toHaveBeenCalledExactlyOnceWith(expected.result);
      expect(legalMoves).toHaveBeenCalledTimes(expected.state === "active" ? 1 : 0);
    } finally {
      pgn.mockRestore();
      legalMoves.mockRestore();
    }
  });

  it("returns a normal defensive command snapshot after projection-free restoration", () => {
    const original = activeGame();
    play(original, KNIGHT_CYCLE);
    const expected = unwrap(original.playMove("e2e4"));
    const pgn = vi.spyOn(ChessRules.prototype, "pgn");
    const legalMoves = vi.spyOn(ChessRules.prototype, "legalMoves");
    try {
      const restored = unwrap(restoreGame({ moves: KNIGHT_CYCLE, lifecycle: ACTIVE }));
      expect(pgn).not.toHaveBeenCalled();
      expect(legalMoves).not.toHaveBeenCalled();
      expect(Object.keys(restored).sort()).toEqual([
        "abort",
        "pause",
        "playMove",
        "recordTechnicalLoss",
        "resignHuman",
        "resume",
        "snapshot",
        "start",
      ]);

      const returned = unwrap(restored.playMove("e2e4"));
      expect(returned).toEqual(expected);
      expect(pgn).toHaveBeenCalledExactlyOnceWith("*");
      expect(legalMoves).toHaveBeenCalledTimes(1);

      Object.assign(returned, { fen: "changed", state: "completed" });
      (returned.legalMoves as string[]).splice(0);
      Object.assign(returned.moves[0] ?? {}, { uci: "a1a8", san: "changed" });
      (returned.moves as unknown[]).splice(0);
      expect(restored.snapshot()).toEqual(expected);
    } finally {
      pgn.mockRestore();
      legalMoves.mockRestore();
    }
  });

  it.each(histories)(
    "reconstructs $name from UCI and round-trips the resulting PGN",
    ({ moves }) => {
      const original = activeGame();
      play(original, moves);
      const restored = unwrap(restoreGame({ moves, lifecycle: lifecycleOf(original) }));
      expect(restored.snapshot()).toEqual(original.snapshot());

      const parsed = new Chess();
      parsed.loadPgn(restored.snapshot().pgn, { strict: true });
      expect(parsed.fen()).toBe(restored.snapshot().fen);
      expect(
        parsed
          .history({ verbose: true })
          .map((move) => `${move.from}${move.to}${move.promotion ?? ""}`),
      ).toEqual(moves);
      expect(parsed.getHeaders()).toMatchObject({
        White: "?",
        Black: "?",
        Result: restored.snapshot().result,
      });
      expect(parsed.getComments()).toEqual([]);
      expect(parsed.getHeaders()).not.toHaveProperty("FEN");
      expect(parsed.getHeaders()).not.toHaveProperty("SetUp");
    },
  );

  it("restores a configuring game only with empty history", () => {
    const original = createGame();
    expect(unwrap(restoreGame({ moves: [], lifecycle: lifecycleOf(original) })).snapshot()).toEqual(
      original.snapshot(),
    );
    expect(restoreGame({ moves: ["e2e4"], lifecycle: lifecycleOf(original) })).toEqual({
      ok: false,
      error: { code: "INVALID_LIFECYCLE" },
    });
  });

  it.each(["pause", "abort", "resignHuman", "recordTechnicalLoss"] as const)(
    "preserves non-board lifecycle metadata from %s",
    (method) => {
      for (const moves of [[], ["e2e4", "e7e5", ...KNIGHT_CYCLE]]) {
        const original = activeGame();
        play(original, moves);
        unwrap(
          method === "resignHuman" || method === "recordTechnicalLoss"
            ? original[method]("black")
            : original[method](),
        );
        const restored = unwrap(restoreGame({ moves, lifecycle: lifecycleOf(original) }));
        expect(restored.snapshot()).toEqual(original.snapshot());
        expect(restored.snapshot().pgn.endsWith(restored.snapshot().result)).toBe(true);
      }
    },
  );

  it("does not retain references to the input history or lifecycle", () => {
    const moves = ["e2e4"];
    const lifecycle: GameLifecycle = { ...ACTIVE };
    const restored = unwrap(restoreGame({ moves, lifecycle }));
    const before = restored.snapshot();
    moves[0] = "d2d4";
    Object.assign(lifecycle, { state: "completed", result: "1-0" });
    expect(restored.snapshot()).toEqual(before);
  });

  it("replays a prefix without mutating the source game", () => {
    const original = activeGame();
    play(original, FOOLS_MATE);
    const before = original.snapshot();
    const prefix = unwrap(restoreGame({ moves: FOOLS_MATE.slice(0, 2), lifecycle: ACTIVE }));
    expect(prefix.snapshot().moves).toHaveLength(2);
    expect(prefix.snapshot().result).toBe("*");
    expect(original.snapshot()).toEqual(before);
  });

  it.each([
    { moves: ["e2e5"], ply: 1 },
    { moves: ["e2e4", "d2d4"], ply: 2 },
    { moves: ["Nf3"], ply: 1 },
    { moves: [...FOOLS_MATE, "a2a3"], ply: 5 },
    { moves: [...KNIGHT_CYCLE, ...KNIGHT_CYCLE, "e2e4"], ply: 9 },
    { moves: ["e2e4", "secret-canary"], ply: 2 },
    { moves: [null], ply: 1 },
    { moves: Array<string>(1), ply: 1 },
  ])("rejects corrupt or post-terminal history at ply $ply: $moves", ({ moves, ply }) => {
    const result = restoreGame({ moves, lifecycle: ACTIVE } as RestoreGameInput);
    expect(result).toEqual({ ok: false, error: { code: "INVALID_HISTORY", ply } });
    expect(JSON.stringify(result)).not.toContain("secret-canary");
  });

  it.each([
    null,
    { moves: "e2e4", lifecycle: ACTIVE },
    { fen: INITIAL_FEN, lifecycle: ACTIVE },
    { moves: [], lifecycle: ACTIVE, fen: INITIAL_FEN },
    { moves: [] },
  ])("rejects missing history or unsupported restore inputs: %j", (input) => {
    expect(restoreGame(input as RestoreGameInput)).toEqual({
      ok: false,
      error: { code: "INVALID_HISTORY" },
    });
  });

  it.each([
    null,
    { state: "active", result: "1-0", terminationReason: "checkmate" },
    { state: "active", result: "*" },
    { state: "active", result: "*", terminationReason: null, secret: "canary" },
    { state: "completed", result: "*", terminationReason: "checkmate" },
    { state: "completed", result: "1/2-1/2", terminationReason: "human_resignation" },
    { state: "aborted", result: "0-1", terminationReason: "aborted" },
  ])("rejects invalid lifecycle metadata: %j", (lifecycle) => {
    expect(restoreGame({ moves: [], lifecycle } as RestoreGameInput)).toEqual({
      ok: false,
      error: { code: "INVALID_LIFECYCLE" },
    });
  });

  it.each([
    { state: "active", result: "*", terminationReason: null },
    { state: "paused", result: "*", terminationReason: null },
    { state: "aborted", result: "*", terminationReason: "aborted" },
    { state: "completed", result: "1-0", terminationReason: "checkmate" },
    { state: "completed", result: "0-1", terminationReason: "human_resignation" },
    { state: "completed", result: "1/2-1/2", terminationReason: "stalemate" },
  ] as const)("rejects lifecycle contradicting the replayed mate: %j", (lifecycle) => {
    expect(restoreGame({ moves: FOOLS_MATE, lifecycle })).toEqual({
      ok: false,
      error: { code: "INVALID_LIFECYCLE" },
    });
  });

  it.each([
    "checkmate",
    "stalemate",
    "insufficient_material",
    "threefold_repetition",
    "fifty_move_rule",
  ] as const)("rejects an asserted %s that is not present in history", (terminationReason) => {
    const lifecycle: GameLifecycle =
      terminationReason === "checkmate"
        ? { state: "completed", result: "1-0", terminationReason }
        : { state: "completed", result: "1/2-1/2", terminationReason };
    expect(restoreGame({ moves: [], lifecycle })).toEqual({
      ok: false,
      error: { code: "INVALID_LIFECYCLE" },
    });
  });
});
