import { createGame } from "@neurochess/chess";
import { describe, expect, it } from "vitest";

import { historyDigest, positionFacts, PROFILE_ID, validateRequest } from "./protocol";

const gameId = "f0cfe67b-38a0-4e83-aec4-96c81ef479b7";

async function request(moves: string[]) {
  const game = createGame();
  game.start();
  for (const move of moves) expect(game.playMove(move).ok).toBe(true);
  return {
    lifetime: "view-1",
    gameId,
    generation: 1,
    ply: moves.length,
    fen: game.snapshot().fen,
    moves,
    historyDigest: await historyDigest(moves),
    profileId: PROFILE_ID,
  };
}

describe("analysis history identity", () => {
  it("lets the page interrupt a long validation before creating an engine", async () => {
    const moves = [
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1b5",
      "a7a6",
      "b5a4",
      "g8f6",
      "e1g1",
      "f8e7",
      "f1e1",
      "b7b5",
      "a4b3",
      "d7d6",
      "c2c3",
      "e8g8",
    ];
    const target = await request(moves);
    const controller = new AbortController();
    const interrupt = setTimeout(() => controller.abort(), 0);
    try {
      await expect(
        Promise.resolve(positionFacts(moves, target.fen, controller.signal)),
      ).rejects.toThrow("analysis_cancelled");
    } finally {
      clearTimeout(interrupt);
    }
  });
  it("distinguishes transposed histories with the same final FEN", async () => {
    const first = await request(["g1f3", "g8f6", "b1c3", "b8c6"]);
    const transposed = await request(["b1c3", "b8c6", "g1f3", "g8f6"]);
    expect(first.fen).toBe(transposed.fen);
    expect(first.historyDigest).not.toBe(transposed.historyDigest);
    await expect(
      validateRequest({ ...first, historyDigest: transposed.historyDigest }),
    ).rejects.toThrow("engine_protocol_error");
  });
  it("uses the specified JSON prefix digest, including ply zero", async () => {
    expect(await historyDigest([])).toBe(
      "c562a09adf818d7f7223abf87a2269ecbfd58b5bf3660bcda356df2eb6cbdff5",
    );
    const initial = await request([]);
    expect((await validateRequest(initial)).position).toEqual({
      turn: "white",
      checkmate: false,
      noLegalMoves: false,
    });
  });

  it("verifies FEN, prefix, digest, ply, profile and lifetime without echoing invalid data", async () => {
    const valid = await request(["e2e4"]);
    for (const change of [
      { fen: createGame().snapshot().fen },
      { moves: ["e2e5"] },
      { ply: 0 },
      { historyDigest: "0".repeat(64) },
      { profileId: "unknown" },
      { lifetime: "" },
      { generation: 0 },
      { extra: "private" },
    ]) {
      await expect(validateRequest({ ...valid, ...change })).rejects.toThrow(
        "engine_protocol_error",
      );
    }
  });

  it("recognizes terminal board facts from accepted history alone", async () => {
    const mate = await request(["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect((await validateRequest(mate)).position).toEqual({
      turn: "white",
      checkmate: true,
      noLegalMoves: true,
    });
    const repetition = await request([
      "g1f3",
      "g8f6",
      "f3g1",
      "f6g8",
      "g1f3",
      "g8f6",
      "f3g1",
      "f6g8",
    ]);
    expect((await validateRequest(repetition)).position.noLegalMoves).toBe(false);
  });
});
