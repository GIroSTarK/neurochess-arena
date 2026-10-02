import { describe, expect, it } from "vitest";

import {
  gameHistoryClearRequestSchema,
  gameHistoryCursorSchema,
  gameHistoryDeletedResponseSchema,
  gameHistoryDeleteRequestSchema,
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

describe("history deletion transport", () => {
  it("names exactly one game and never accepts a client-selected owner or scope", () => {
    expect(gameHistoryDeleteRequestSchema.parse({ gameId: id })).toEqual({ gameId: id });
    for (const body of [
      {},
      { gameId: "invalid" },
      { gameId: [id] },
      { gameId: id, ownerUserId: id },
      { gameId: id, all: true },
      { gameIds: [id] },
    ]) {
      expect(gameHistoryDeleteRequestSchema.safeParse(body).success).toBe(false);
    }
  });
  it("requires explicit confirmation to clear and acknowledges both operations without details", () => {
    expect(gameHistoryClearRequestSchema.parse({ confirm: true })).toEqual({ confirm: true });
    for (const body of [
      {},
      { confirm: false },
      { confirm: "true" },
      { confirm: true, userId: id },
    ]) {
      expect(gameHistoryClearRequestSchema.safeParse(body).success).toBe(false);
    }
    expect(gameHistoryDeletedResponseSchema.parse({ status: "deleted" })).toEqual({
      status: "deleted",
    });
    for (const body of [{ status: "missing" }, { status: "deleted", count: 1 }, {}]) {
      expect(gameHistoryDeletedResponseSchema.safeParse(body).success).toBe(false);
    }
  });
});
