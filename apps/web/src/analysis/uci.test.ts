import { describe, expect, it } from "vitest";

import { parseCompletion, parseScore, profileCommands, UciLines } from "./uci";

describe("bounded UCI parsing", () => {
  it("handles partial and multiline output without retaining previous lines", () => {
    const lines = new UciLines();
    expect(lines.push("info dep")).toEqual([]);
    expect(lines.push("th 4 score cp 21\r\nreadyok\ninfo ")).toEqual([
      "info depth 4 score cp 21",
      "readyok",
    ]);
    expect(lines.push("depth 5 score cp 0\n")).toEqual(["info depth 5 score cp 0"]);
  });

  it("rejects oversized lines, buffers, and non-text output with safe errors", () => {
    expect(() => new UciLines().push("x".repeat(16385) + "\n")).toThrow("resource_limit");
    expect(() => new UciLines().push("x".repeat(65537))).toThrow("resource_limit");
    expect(() => new UciLines().push({ secret: "must not escape" })).toThrow(
      "engine_protocol_error",
    );
  });

  it.each([
    ["white", "cp 23", { kind: "cp", value: 23 }],
    ["black", "cp 23", { kind: "cp", value: -23 }],
    ["black", "cp 0", { kind: "cp", value: 0 }],
    ["black", "mate 3", { kind: "mate", winner: "black", moves: 3 }],
    ["black", "mate -3", { kind: "mate", winner: "white", moves: 3 }],
    ["white", "mate -128", { kind: "mate", winner: "black", moves: 128 }],
  ] as const)("normalizes %s %s to White once", (turn, score, expected) => {
    expect(
      parseScore(`info depth 12 multipv 1 score ${score} nodes 99 pv e2e4`, {
        turn,
        checkmate: false,
      }),
    ).toEqual({ depth: 12, score: expected });
  });

  it.each([
    "info depth 19 score cp 1",
    "info depth -1 score cp 1",
    "info depth 2.5 score cp 1",
    "info depth 3 score cp 100001",
    "info depth 3 score cp NaN",
    "info depth 3 score cp 1.1",
    "info depth 3 score mate 129",
    "info depth 3 score mate 0",
    "info depth 3 score cp 1 lowerbound",
    "info depth 3 score cp 1 upperbound",
    "info depth 3 multipv 2 score cp 1",
    "info score cp 2",
    "info depth 3 score cp 1 score mate 1",
    "info depth 3 score cp 1oops",
  ])("does not fabricate an exact score from %s", (line) => {
    expect(parseScore(line, { turn: "white", checkmate: false })).toBeUndefined();
  });

  it("allows mate zero only for a prefix independently verified as checkmate", () => {
    expect(parseScore("info depth 0 score mate 0", { turn: "white", checkmate: true })).toEqual({
      depth: 0,
      score: { kind: "mate", winner: "black", moves: 0 },
    });
    expect(parseScore("info depth 0 score cp 0", { turn: "white", checkmate: false })).toEqual({
      depth: 0,
      score: { kind: "cp", value: 0 },
    });
    expect(parseCompletion("bestmove (none)", true)).toBe(true);
    expect(parseCompletion("bestmove 0000", false)).toBe(false);
    expect(parseCompletion("bestmove e2e4 ponder e7e5", false)).toBe(true);
    expect(parseCompletion("bestmove nonsense", true)).toBe(false);
  });

  it("verifies every configured option against the advertised capability", () => {
    const options = [
      "option name Threads type spin default 1 min 1 max 1",
      "option name Hash type spin default 16 min 1 max 33554432",
      "option name MultiPV type spin default 1 min 1 max 256",
      "option name Ponder type check default false",
      "option name UCI_LimitStrength type check default false",
      "option name Skill Level type spin default 20 min 0 max 20",
      "option name UCI_Chess960 type check default false",
    ];
    expect(profileCommands(options)).toContain("setoption name Hash value 16");
    expect(profileCommands(options)).toContain("setoption name Threads value 1");
    expect(() => profileCommands(options.slice(1))).toThrow("engine_protocol_error");
    expect(() => profileCommands(options.map((line) => line.replace("max 256", "max 0")))).toThrow(
      "engine_protocol_error",
    );
  });
});
