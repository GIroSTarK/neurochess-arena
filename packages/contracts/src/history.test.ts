import { describe, expect, it } from "vitest";

import { gameHistoryPageSchema, gameHistoryQuerySchema } from "./history.js";

const gameId = "e13d2b75-702c-45cd-ac8b-333333333333";
const finishedAt = "2026-09-26T12:00:00.123456Z";
const cursor = `${finishedAt}/${gameId}`;
const item = {
  gameId,
  finishedAt,
  mode: "ai_vs_human",
  players: {
    white: { type: "human", username: "Alice" },
    black: { type: "ai", provider: "openai", modelId: "example" },
  },
  state: "aborted",
  result: "*",
  terminationReason: "aborted",
};

describe("private history contracts", () => {
  it("bounds pages and retains a precise stable cursor", () => {
    expect(gameHistoryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(gameHistoryQuerySchema.parse({ limit: "50", cursor })).toEqual({ limit: 50, cursor });
    for (const query of [
      { limit: "0" },
      { limit: "51" },
      { limit: "1.5" },
      { limit: "" },
      { limit: true },
      { limit: ["1"] },
      { cursor: "bad" },
      { cursor: cursor.replace("09-26", "02-30") },
      { userId: "another-account" },
    ]) {
      expect(gameHistoryQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("allows only consistent terminal summaries and bounded safe player metadata", () => {
    const page = { games: [item], nextCursor: cursor };
    expect(gameHistoryPageSchema.parse(page)).toEqual(page);
    for (const patch of [
      { state: "paused" },
      { result: "1-0" },
      { terminationReason: "checkmate" },
      { apiKey: "secret" },
      { players: { ...item.players, white: { type: "human", email: "a@b.test" } } },
      { mode: "ai_vs_ai" },
    ]) {
      expect(
        gameHistoryPageSchema.safeParse({ ...page, games: [{ ...item, ...patch }] }).success,
      ).toBe(false);
    }
    expect(
      gameHistoryPageSchema.safeParse({ ...page, games: Array.from({ length: 51 }, () => item) })
        .success,
    ).toBe(false);
  });
});
