import { describe, expect, it } from "vitest";

import {
  gameHistoryCursorSchema,
  gameHistoryEntrySchema,
  gameHistoryQuerySchema,
  gameHistoryResponseSchema,
} from "./history.js";

const id = "10000000-0000-4000-8000-000000000001";
const entry = {
  gameId: id,
  finishedAt: "2026-10-01T00:00:00.123456Z",
  configuration: {
    mode: "ai_vs_ai",
    seats: {
      white: { type: "ai", provider: "openai", modelId: "a", parameters: {} },
      black: { type: "ai", provider: "google", modelId: "b", parameters: {} },
    },
  },
  state: "aborted",
  result: "*",
  terminationReason: "aborted",
};
describe("history transport bounds", () => {
  it("defaults to twenty results and permits at most fifty with a precise cursor", () => {
    expect(gameHistoryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      gameHistoryQuerySchema.parse({ limit: "50", cursor: entry.finishedAt + "_" + id }).limit,
    ).toBe(50);
    for (const limit of [0, -1, 51, "", "Infinity", 1.1]) {
      expect(gameHistoryQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    expect(
      gameHistoryResponseSchema.safeParse({
        games: Array.from({ length: 51 }, () => entry),
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
  it("rejects malformed dates, truncation, invalid UUIDs, and injected cursor fields", () => {
    for (const cursor of [
      "",
      "2026-10-01T00:00:00.123Z_" + id,
      "0000-10-01T00:00:00.123456Z_" + id,
      "2026-02-30T00:00:00.123456Z_" + id,
      entry.finishedAt + "_invalid",
      entry.finishedAt + "_" + id + "_extra",
    ]) {
      expect(gameHistoryCursorSchema.safeParse(cursor).success).toBe(false);
    }
    expect(gameHistoryQuerySchema.safeParse({ userId: id }).success).toBe(false);
  });
  it("admits only consistent terminal states and safe configurations without private extras", () => {
    expect(gameHistoryEntrySchema.safeParse(entry).success).toBe(true);
    for (const patch of [
      { state: "paused" },
      { result: "1-0" },
      { terminationReason: "checkmate" },
      { configuration: null },
      { apiKey: "private" },
    ]) {
      expect(gameHistoryEntrySchema.safeParse({ ...entry, ...patch }).success).toBe(false);
    }
  });
});
