import { describe, expect, it } from "vitest";

import {
  gameDeleteRequestSchema,
  gameHistoryClearRequestSchema,
  gameHistoryCursorSchema,
  gameHistoryDeletedResponseSchema,
  gameHistoryEntrySchema,
  gameHistoryQuerySchema,
  gameHistoryResponseSchema,
} from "./history.js";

const id = "10000000-0000-4000-8000-000000000001";
const entry = {
  gameId: id,
  finishedAt: "2026-10-01T00:00:00.123456Z",
  players: { white: null, black: null },
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
  it("requires safe labels matching the actual human seats without private identity fields", () => {
    const room = {
      ...entry,
      configuration: {
        mode: "human_vs_human",
        seats: { white: { type: "human" }, black: { type: "human" } },
      },
      players: { white: { kind: "account", username: "Player" }, black: { kind: "guest" } },
    };
    expect(gameHistoryEntrySchema.safeParse(room).success).toBe(true);
    for (const white of [
      null,
      { kind: "account", username: "<script>" },
      { kind: "account", username: "Player", userId: id },
      { kind: "deleted", username: "FormerPlayer" },
    ]) {
      expect(
        gameHistoryEntrySchema.safeParse({ ...room, players: { ...room.players, white } }).success,
      ).toBe(false);
    }
    expect(gameHistoryEntrySchema.safeParse({ ...entry, players: room.players }).success).toBe(
      false,
    );
  });
  it("requires explicit, strictly scoped deletion confirmation", () => {
    expect(gameDeleteRequestSchema.parse({ gameId: id, confirm: true })).toEqual({
      gameId: id,
      confirm: true,
    });
    expect(gameHistoryClearRequestSchema.parse({ confirm: true })).toEqual({ confirm: true });
    for (const confirm of [undefined, false, "true", 1]) {
      expect(gameDeleteRequestSchema.safeParse({ gameId: id, confirm }).success).toBe(false);
      expect(gameHistoryClearRequestSchema.safeParse({ confirm }).success).toBe(false);
    }
    for (const gameId of [undefined, "", "all", [id]]) {
      expect(gameDeleteRequestSchema.safeParse({ gameId, confirm: true }).success).toBe(false);
    }
    for (const extra of [{ ownerUserId: id }, { gameIds: [id] }, { state: "active" }]) {
      expect(
        gameDeleteRequestSchema.safeParse({ gameId: id, confirm: true, ...extra }).success,
      ).toBe(false);
      expect(gameHistoryClearRequestSchema.safeParse({ confirm: true, ...extra }).success).toBe(
        false,
      );
    }
    expect(gameHistoryDeletedResponseSchema.parse({ status: "deleted" })).toEqual({
      status: "deleted",
    });
    expect(
      gameHistoryDeletedResponseSchema.safeParse({ status: "deleted", count: 1 }).success,
    ).toBe(false);
  });
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
