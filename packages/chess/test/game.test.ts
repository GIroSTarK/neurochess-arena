import { describe, expect, it } from "vitest";

import * as publicApi from "../src/index.js";
import { createGame } from "../src/index.js";

import { activeGame, FOOLS_MATE, INITIAL_FEN, play, position, unwrap } from "./fixtures.js";

describe("public chess API", () => {
  it("creates only the standard position and requires an explicit start", () => {
    const game = createGame();
    expect(game.snapshot()).toMatchObject({
      state: "configuring",
      result: "*",
      terminationReason: null,
      fen: INITIAL_FEN,
      turn: "white",
      inCheck: false,
      moves: [],
      legalMoves: [],
    });
    const started = unwrap(game.start());
    expect(started.state).toBe("active");
    expect(started.legalMoves).toHaveLength(20);
    expect(started.legalMoves).toEqual([...started.legalMoves].sort());
    expect(started.legalMoves).toEqual(expect.arrayContaining(["e2e4", "g1f3"]));
    expect(Object.keys(game)).not.toEqual(expect.arrayContaining(["engine", "rules"]));
    for (const internal of ["Chess", "ChessRules", "createGameWithRules", "position", "loadFen"]) {
      expect(publicApi).not.toHaveProperty(internal);
    }
  });

  it.each([
    { name: "empty string", input: "" },
    { name: "SAN pawn move", input: "e4" },
    { name: "SAN knight move", input: "Nf3" },
    { name: "null-move digits", input: "0000" },
    { name: "null-move dashes", input: "--" },
    { name: "uppercase squares", input: "E2E4" },
    { name: "leading space", input: " e2e4" },
    { name: "trailing space", input: "e2e4 " },
    { name: "trailing LF", input: "e2e4\n" },
    { name: "trailing CRLF", input: "e2e4\r\n" },
    { name: "promotion with trailing LF", input: "e2e4q\n" },
    { name: "rank outside board", input: "a0a1" },
    { name: "file outside board", input: "i2i4" },
    { name: "uppercase promotion", input: "e7e8Q" },
    { name: "king promotion", input: "e7e8k" },
    { name: "same square", input: "e2e2" },
    { name: "null", input: null },
    { name: "undefined", input: undefined },
    { name: "number", input: 42 },
    { name: "object", input: { move: "e2e4" } },
  ])("rejects noncanonical UCI without mutation: $name", ({ input }) => {
    const game = activeGame();
    const before = game.snapshot();
    expect(game.playMove(input as string)).toEqual({ ok: false, error: { code: "INVALID_UCI" } });
    expect(game.snapshot()).toEqual(before);
  });

  it.each(["e2e5", "e7e5", "c1h6", "e2e4q", "e1g1", "a7a8q"])(
    "rejects a syntactically valid but illegal move: %s",
    (uci) => {
      const game = activeGame();
      const before = game.snapshot();
      expect(game.playMove(uci)).toEqual({ ok: false, error: { code: "ILLEGAL_MOVE" } });
      expect(game.snapshot()).toEqual(before);
    },
  );

  it("derives UCI history, SAN, FEN and side to move together", () => {
    const game = activeGame();
    play(game, ["e2e4", "e7e5", "g1f3", "b8c6"]);
    const snapshot = game.snapshot();
    expect(snapshot.moves.map(({ ply, uci, san }) => ({ ply, uci, san }))).toEqual([
      { ply: 1, uci: "e2e4", san: "e4" },
      { ply: 2, uci: "e7e5", san: "e5" },
      { ply: 3, uci: "g1f3", san: "Nf3" },
      { ply: 4, uci: "b8c6", san: "Nc6" },
    ]);
    expect(snapshot.fen).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
    expect(snapshot.moves.at(-1)?.fen).toBe(snapshot.fen);
    expect(snapshot.turn).toBe("white");
    expect(snapshot.pgn).toContain("1. e4 e5 2. Nf3 Nc6 *");
  });

  it("uses SAN disambiguation for otherwise identical pieces", () => {
    const game = position("7k/8/8/8/8/8/8/KN3N2 w - - 0 1");
    expect(unwrap(game.playMove("b1d2")).moves[0]?.san).toBe("Nbd2");
  });

  it("returns defensive snapshots, including snapshots returned from commands", () => {
    const game = activeGame();
    const returned = unwrap(game.playMove("e2e4"));
    const before = game.snapshot();
    Object.assign(returned, { fen: "changed", state: "completed" });
    (returned.legalMoves as string[]).splice(0);
    Object.assign(returned.moves[0] ?? {}, { uci: "a1a8", san: "changed" });
    (returned.moves as unknown[]).push({ uci: "a1a8" });
    expect(game.snapshot()).toEqual(before);
  });
});

describe("king safety", () => {
  it("prevents a pinned piece from exposing its king", () => {
    const game = position("4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1");
    const before = game.snapshot();
    expect(before.legalMoves).not.toContain("e2f2");
    expect(game.playMove("e2f2")).toEqual({ ok: false, error: { code: "ILLEGAL_MOVE" } });
    expect(game.snapshot()).toEqual(before);
    expect(game.playMove("e2e3").ok).toBe(true);
  });

  it("requires a response to check and forbids moving into attack", () => {
    const game = position("4r1k1/8/8/8/8/8/P7/4K3 w - - 0 1");
    expect(game.snapshot().inCheck).toBe(true);
    for (const move of ["a2a3", "e1e2"]) {
      expect(game.playMove(move)).toEqual({ ok: false, error: { code: "ILLEGAL_MOVE" } });
    }
    expect(unwrap(game.playMove("e1d1")).inCheck).toBe(false);
  });
});

describe("castling", () => {
  it.each([
    ["w", "e1g1", "O-O", "R4RK1", "kq"],
    ["w", "e1c1", "O-O-O", "2KR3R", "kq"],
    ["b", "e8g8", "O-O", "r4rk1", "KQ"],
    ["b", "e8c8", "O-O-O", "2kr3r", "KQ"],
  ])("moves both pieces for %s %s", (side, uci, san, rank, rights) => {
    const game = position(`r3k2r/8/8/8/8/8/8/R3K2R ${side} KQkq - 0 1`);
    expect(game.snapshot().legalMoves).toContain(uci);
    const snapshot = unwrap(game.playMove(uci));
    expect(snapshot.moves[0]?.san).toBe(san);
    expect(snapshot.fen.split(" ")[0]?.split("/")[side === "w" ? 7 : 0]).toBe(rank);
    expect(snapshot.fen.split(" ")[2]).toBe(rights);
  });

  it.each([
    ["k3r3/8/8/8/8/8/8/4K2R w K - 0 1", "e1g1"],
    ["k4r2/8/8/8/8/8/8/4K2R w K - 0 1", "e1g1"],
    ["k5r1/8/8/8/8/8/8/4K2R w K - 0 1", "e1g1"],
    ["k3r3/8/8/8/8/8/8/R3K3 w Q - 0 1", "e1c1"],
    ["k2r4/8/8/8/8/8/8/R3K3 w Q - 0 1", "e1c1"],
    ["k1r5/8/8/8/8/8/8/R3K3 w Q - 0 1", "e1c1"],
    ["4k2r/8/8/8/8/8/8/K4R2 b k - 0 1", "e8g8"],
    ["r3k3/8/8/8/8/8/8/K2R4 b q - 0 1", "e8c8"],
  ])("rejects castling out of, through, or into check: %s", (fen, move) => {
    const game = position(fen);
    expect(game.snapshot().legalMoves).not.toContain(move);
    expect(game.playMove(move)).toEqual({ ok: false, error: { code: "ILLEGAL_MOVE" } });
  });

  it("does not restore castling rights when kings return to their starting squares", () => {
    const game = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    play(game, ["e1f1", "e8f8", "f1e1", "f8e8"]);
    expect(game.snapshot().fen.split(" ")[2]).toBe("-");
    expect(game.snapshot().legalMoves).not.toContain("e1g1");
    expect(game.snapshot().legalMoves).not.toContain("e1c1");
  });

  it.each([
    {
      name: "kingside rooks",
      moves: ["h1h2", "h8h7", "h2h1", "h7h8"],
      rights: "Qq",
      lost: "e1g1",
      retained: "e1c1",
    },
    {
      name: "queenside rooks",
      moves: ["a1a2", "a8a7", "a2a1", "a7a8"],
      rights: "Kk",
      lost: "e1c1",
      retained: "e1g1",
    },
  ] as const)("does not restore rights after $name return", ({ moves, rights, lost, retained }) => {
    const game = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    play(game, moves);
    expect(game.snapshot().fen.split(" ")[2]).toBe(rights);
    expect(game.snapshot().legalMoves).not.toContain(lost);
    expect(game.snapshot().legalMoves).toContain(retained);
  });
});

describe("en passant", () => {
  const opening = ["e2e4", "a7a6", "e4e5", "d7d5"];

  it("accepts an immediate capture and removes the passed pawn", () => {
    const game = activeGame();
    play(game, opening);
    expect(game.snapshot().fen.split(" ")[3]).toBe("d6");
    const snapshot = unwrap(game.playMove("e5d6"));
    expect(snapshot.moves.at(-1)?.san).toBe("exd6");
    expect(snapshot.fen).toBe("rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3");
  });

  it("also supports Black capturing en passant", () => {
    const game = activeGame();
    play(game, ["a2a3", "e7e5", "a3a4", "e5e4", "d2d4"]);
    const snapshot = unwrap(game.playMove("e4d3"));
    expect(snapshot.moves.at(-1)?.san).toBe("exd3");
    expect(snapshot.fen).toBe("rnbqkbnr/pppp1ppp/8/8/P7/3p4/1PP1PPPP/RNBQKBNR w KQkq - 0 4");
  });

  it("expires the opportunity after an intervening move", () => {
    const game = activeGame();
    play(game, [...opening, "g1f3", "g8f6"]);
    expect(game.snapshot().fen.split(" ")[3]).toBe("-");
    expect(game.playMove("e5d6")).toEqual({ ok: false, error: { code: "ILLEGAL_MOVE" } });
  });

  it("rejects en passant when moving the pawn would expose its king", () => {
    const game = position("k3r1n1/3p4/8/4P3/8/8/8/4K1N1 b - - 0 1");
    unwrap(game.playMove("d7d5"));
    const before = game.snapshot();
    expect(before.fen.split(" ")[3]).toBe("-");
    expect(before.legalMoves).not.toContain("e5d6");
    expect(game.playMove("e5d6")).toEqual({ ok: false, error: { code: "ILLEGAL_MOVE" } });
    expect(game.snapshot()).toEqual(before);
  });
});

describe.each([
  {
    name: "white quiet",
    fen: "7k/P7/8/8/8/8/7p/K7 w - - 17 1",
    prefix: "a7a8",
    rank: 0,
    template: "X6k",
  },
  {
    name: "black quiet",
    fen: "7k/P7/8/8/8/8/7p/K7 b - - 17 1",
    prefix: "h2h1",
    rank: 7,
    template: "K6x",
  },
  {
    name: "white capture",
    fen: "1r5k/P7/8/8/8/8/7p/K7 w - - 17 1",
    prefix: "a7b8",
    rank: 0,
    template: "1X5k",
  },
  {
    name: "black capture",
    fen: "7k/P7/8/8/8/8/7p/K5R1 b - - 17 1",
    prefix: "h2g1",
    rank: 7,
    template: "K5x1",
  },
])("promotion: $name", ({ fen, prefix, rank, template }) => {
  it.each(["q", "r", "b", "n"])("accepts an explicit %s promotion", (piece) => {
    const game = position(fen);
    expect(game.snapshot().legalMoves.filter((move) => move.startsWith(prefix))).toHaveLength(4);
    const snapshot = unwrap(game.playMove(`${prefix}${piece}`));
    expect(snapshot.moves[0]?.uci).toBe(`${prefix}${piece}`);
    expect(snapshot.moves[0]?.san).toContain(`=${piece.toUpperCase()}`);
    expect(snapshot.fen.split(" ")[0]?.split("/")[rank]).toBe(
      template.replace("X", piece.toUpperCase()).replace("x", piece),
    );
    expect(snapshot.fen.split(" ")[4]).toBe("0");
  });

  it("does not silently promote to a queen when the suffix is absent", () => {
    const game = position(fen);
    const before = game.snapshot();
    expect(game.playMove(prefix)).toEqual({ ok: false, error: { code: "ILLEGAL_MOVE" } });
    expect(game.snapshot()).toEqual(before);
  });
});

describe("checkmate and material outcomes", () => {
  it("completes Fool's Mate with a black victory and matching PGN", () => {
    const game = activeGame();
    play(game, FOOLS_MATE);
    expect(game.snapshot()).toMatchObject({
      state: "completed",
      result: "0-1",
      terminationReason: "checkmate",
      legalMoves: [],
      inCheck: true,
    });
    expect(game.snapshot().moves.at(-1)?.san).toBe("Qh4#");
    expect(game.snapshot().pgn).toContain('[Result "0-1"]');
    expect(game.snapshot().pgn).toMatch(/Qh4# 0-1$/);
  });

  it("detects stalemate without check", () => {
    expect(position("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").snapshot()).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "stalemate",
      inCheck: false,
    });
  });

  it.each([
    "7k/8/8/8/8/8/8/K7 w - - 0 1",
    "7k/8/8/8/8/8/B7/K7 w - - 0 1",
    "7k/8/8/8/8/8/N7/K7 w - - 0 1",
    "5b1k/8/8/8/8/8/8/K1B5 w - - 0 1",
  ])("detects insufficient material: %s", (fen) => {
    expect(position(fen).snapshot()).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "insufficient_material",
      legalMoves: [],
    });
  });

  it.each([
    "7k/8/8/8/8/8/NN6/K7 w - - 0 1",
    "2b4k/8/8/8/8/8/8/K1B5 w - - 0 1",
    "7k/8/8/8/8/8/BN6/K7 w - - 0 1",
    "7k/8/8/8/8/8/R7/K7 w - - 0 1",
    "7k/8/8/8/8/8/P7/K7 w - - 0 1",
  ])("does not confuse inability to force mate with insufficient material: %s", (fen) => {
    expect(position(fen).snapshot()).toMatchObject({
      state: "active",
      result: "*",
      terminationReason: null,
    });
  });
});
