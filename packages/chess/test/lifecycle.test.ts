import { describe, expect, it } from "vitest";

import { createGame, type ChessColor, type GameLifecycle, type GameState } from "../src/index.js";
import { transitionLifecycle, type LifecycleEvent } from "../src/lifecycle.js";

import { activeGame, unwrap } from "./fixtures.js";

const lifecycles: readonly GameLifecycle[] = [
  { state: "configuring", result: "*", terminationReason: null },
  { state: "active", result: "*", terminationReason: null },
  { state: "paused", result: "*", terminationReason: null },
  { state: "completed", result: "1-0", terminationReason: "checkmate" },
  { state: "aborted", result: "*", terminationReason: "aborted" },
];
const events: readonly { event: LifecycleEvent; allowed: readonly GameState[]; next: GameState }[] =
  [
    { event: { type: "start" }, allowed: ["configuring"], next: "active" },
    { event: { type: "pause" }, allowed: ["active"], next: "paused" },
    { event: { type: "resume" }, allowed: ["paused"], next: "active" },
    { event: { type: "abort" }, allowed: ["active", "paused"], next: "aborted" },
    {
      event: { type: "complete", outcome: { result: "1/2-1/2", terminationReason: "stalemate" } },
      allowed: ["active", "paused"],
      next: "completed",
    },
  ];

describe("pure lifecycle transitions", () => {
  for (const current of lifecycles) {
    for (const { event, allowed, next } of events) {
      it(`${current.state} / ${event.type}`, () => {
        const before = structuredClone({ current, event });
        const result = transitionLifecycle(current, event);
        if (allowed.includes(current.state)) {
          expect(unwrap(result).state).toBe(next);
          expect(unwrap(result)).not.toBe(current);
        } else {
          expect(result).toEqual({ ok: false, error: { code: "INVALID_GAME_STATE" } });
        }
        expect({ current, event }).toEqual(before);
      });
    }
  }
});

describe("aggregate lifecycle", () => {
  it("requires active state for moves, while pausing retains the accepted position", () => {
    const game = createGame();
    const configuring = game.snapshot();
    expect(game.playMove("e2e4")).toEqual({ ok: false, error: { code: "INVALID_GAME_STATE" } });
    expect(game.snapshot()).toEqual(configuring);
    unwrap(game.start());
    unwrap(game.playMove("e2e4"));
    const active = game.snapshot();
    const paused = unwrap(game.pause());
    expect(paused).toEqual({ ...active, state: "paused", legalMoves: [] });
    expect(game.playMove("e7e5")).toEqual({ ok: false, error: { code: "INVALID_GAME_STATE" } });
    expect(game.snapshot()).toEqual(paused);
    expect(unwrap(game.resume())).toEqual(active);
  });

  it.each([
    "start",
    "pause",
    "resume",
    "abort",
    "resignHuman",
    "recordTechnicalLoss",
    "playMove",
  ] as const)("rejects %s after completion or abortion without mutation", (operation) => {
    for (const ending of ["abort", "resignHuman"] as const) {
      const game = activeGame();
      unwrap(ending === "abort" ? game.abort() : game.resignHuman("white"));
      const before = game.snapshot();
      const result =
        operation === "playMove"
          ? game.playMove("e2e4")
          : operation === "resignHuman" || operation === "recordTechnicalLoss"
            ? game[operation]("black")
            : game[operation]();
      expect(result).toEqual({ ok: false, error: { code: "INVALID_GAME_STATE" } });
      expect(game.snapshot()).toEqual(before);
    }
  });

  it.each(["active", "paused"] as const)("aborts from %s without awarding a result", (state) => {
    const game = activeGame();
    unwrap(game.playMove("e2e4"));
    if (state === "paused") unwrap(game.pause());
    const before = game.snapshot();
    const aborted = unwrap(game.abort());
    expect(aborted).toEqual({
      ...before,
      state: "aborted",
      result: "*",
      terminationReason: "aborted",
      legalMoves: [],
    });
    expect(aborted.pgn).toContain('[Result "*"]');
    expect(aborted.pgn.endsWith("*")).toBe(true);
  });

  it("does not permit loss hooks or abort during configuration", () => {
    const game = createGame();
    const before = game.snapshot();
    for (const result of [
      game.abort(),
      game.resignHuman("white"),
      game.recordTechnicalLoss("black"),
    ]) {
      expect(result).toEqual({ ok: false, error: { code: "INVALID_GAME_STATE" } });
    }
    expect(game.snapshot()).toEqual(before);
  });
});

describe.each([
  ["resignHuman", "human_resignation"],
  ["recordTechnicalLoss", "model_technical_loss"],
] as const)("trusted loss hook %s", (method, reason) => {
  for (const state of ["active", "paused"] as const) {
    it.each(["white", "black"] as const)(`completes ${state} for a losing %s seat`, (loser) => {
      const game = activeGame();
      if (state === "paused") unwrap(game.pause());
      const before = game.snapshot();
      const result = loser === "white" ? "0-1" : "1-0";
      const snapshot = unwrap(game[method](loser));
      expect(snapshot).toMatchObject({
        state: "completed",
        result,
        terminationReason: reason,
        legalMoves: [],
      });
      expect(snapshot.fen).toBe(before.fen);
      expect(snapshot.moves).toEqual(before.moves);
      expect(snapshot.pgn).toContain(`[Result "${result}"]`);
      expect(snapshot.pgn.endsWith(result)).toBe(true);
    });
  }

  it("rejects an invalid losing color without producing an arbitrary winner", () => {
    const game = activeGame();
    const before = game.snapshot();
    expect(game[method]("w" as ChessColor)).toEqual({
      ok: false,
      error: { code: "INVALID_COLOR" },
    });
    expect(game.snapshot()).toEqual(before);
  });
});
