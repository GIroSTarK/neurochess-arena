import { describe, expect, it } from "vitest";

import {
  aiGameConfigurationSchema,
  gameDetailsSchema,
  gameHistoryEntrySchema,
  unfinishedGameDetailsSchema,
} from "./index.js";

const ai = { type: "ai", provider: "openai", modelId: "fixture", parameters: {} };
const human = { type: "human" };
const humanConfiguration = { mode: "human_vs_human", seats: { white: human, black: human } };
const snapshot = {
  gameId: "10000000-0000-4000-8000-000000000001",
  version: 0,
  state: "active",
  result: "*",
  terminationReason: null,
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  pgn: '[Result "*"]\n\n*',
  turn: "white",
  inCheck: false,
  legalMoves: ["e2e4"],
  moves: [],
};

describe("common game details", () => {
  it.each([
    { mode: "ai_vs_ai", seats: { white: ai, black: ai } },
    { mode: "ai_vs_human", seats: { white: human, black: ai } },
    { mode: "ai_vs_human", seats: { white: ai, black: human } },
    humanConfiguration,
    null,
  ])("round trips public configurations and legacy null: %j", (configuration) => {
    const details = { snapshot, configuration };
    expect(gameDetailsSchema.parse(details)).toEqual(details);
    expect(unfinishedGameDetailsSchema.parse({ game: details })).toEqual({ game: details });
  });

  it("preserves typed human configuration in terminal history", () => {
    const entry = {
      gameId: snapshot.gameId,
      finishedAt: "2026-10-09T12:00:00.123456Z",
      configuration: humanConfiguration,
      state: "aborted",
      result: "*",
      terminationReason: "aborted",
    };
    expect(gameHistoryEntrySchema.parse(entry)).toEqual(entry);
    expect(
      unfinishedGameDetailsSchema.safeParse({
        game: {
          configuration: humanConfiguration,
          snapshot: { ...snapshot, state: "aborted", terminationReason: "aborted", legalMoves: [] },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects missing, mixed, extra or identity-bearing human seats", () => {
    for (const seats of [
      { white: human },
      { black: human },
      { white: ai, black: human },
      { white: human, black: ai },
      { white: human, black: human, spectator: human },
      { white: { ...human, userId: snapshot.gameId }, black: human },
      { white: human, black: { ...human, guestSessionId: snapshot.gameId } },
      { white: { ...human, provider: "openai" }, black: human },
    ]) {
      expect(
        gameDetailsSchema.safeParse({
          snapshot,
          configuration: { mode: "human_vs_human", seats },
        }).success,
      ).toBe(false);
    }
    expect(
      gameDetailsSchema.safeParse({
        snapshot,
        configuration: { ...humanConfiguration, invitation: "private" },
      }).success,
    ).toBe(false);
  });

  it("keeps AI creation input AI-only", () => {
    expect(aiGameConfigurationSchema.safeParse(humanConfiguration).success).toBe(false);
  });
});
