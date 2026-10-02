import type { GameHistoryEntry, GameHistoryResponse } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../api/failures";
import { GAME_ID } from "../test/fixtures";

import { HistoryController } from "./controller";

const entry: GameHistoryEntry = {
  gameId: GAME_ID,
  finishedAt: "2026-10-01T12:00:00.000001Z",
  configuration: {
    mode: "ai_vs_human",
    seats: {
      white: { type: "human" },
      black: { type: "ai", provider: "openai", modelId: "a", parameters: {} },
    },
  },
  state: "aborted",
  result: "*",
  terminationReason: "aborted",
};
const page: GameHistoryResponse = { games: [entry], nextCursor: null };

function fixture() {
  const identity = new AbortController();
  const api = {
    history: vi.fn(async (): Promise<GameHistoryResponse> => page),
    deleteGame: vi.fn(async () => ({ status: "deleted" as const })),
    clearHistory: vi.fn(async () => ({ status: "deleted" as const })),
  };
  const controller = new HistoryController(api, identity.signal);
  return { identity, api, controller };
}

describe("history mutation lifetimes", () => {
  it.each(["identity", "pagehide", "disconnect"])(
    "fences a pending deletion and clears private confirmation on %s",
    async (boundary) => {
      const { identity, api, controller } = fixture();
      const delayed = Promise.withResolvers<{ status: "deleted" }>();
      api.deleteGame.mockImplementation(() => delayed.promise);
      const disconnect = controller.connect();
      try {
        await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
        controller.confirmGame(entry);
        const pending = controller.deleteConfirmed();
        expect(controller.getSnapshot().deleting).toBe(true);
        if (boundary === "identity") identity.abort();
        else if (boundary === "pagehide") window.dispatchEvent(new Event("pagehide"));
        else disconnect();
        delayed.resolve({ status: "deleted" });
        await pending;
        expect(controller.getSnapshot()).toMatchObject({
          result: null,
          confirmation: null,
          deleting: false,
          success: null,
        });
        expect(api.history).toHaveBeenCalledTimes(1);
      } finally {
        disconnect();
      }
    },
  );

  it("does not allow a superseded read to restore a deleted game", async () => {
    const { api, controller } = fixture();
    const delayed = Promise.withResolvers<GameHistoryResponse>();
    const disconnect = controller.connect();
    try {
      await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
      controller.confirmGame(entry);
      api.history
        .mockImplementationOnce(() => delayed.promise)
        .mockResolvedValue({ games: [], nextCursor: null });
      controller.reload();
      await controller.deleteConfirmed();
      expect(controller.getSnapshot().result?.games).toEqual([]);
      delayed.resolve(page);
      await delayed.promise;
      expect(controller.getSnapshot().result?.games).toEqual([]);
    } finally {
      disconnect();
    }
  });

  it("keeps unfinished-state errors actionable and serializes clear requests", async () => {
    const { api, controller } = fixture();
    const disconnect = controller.connect();
    try {
      await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
      api.deleteGame.mockRejectedValue(new ApiFailure("api", "INVALID_GAME_STATE"));
      controller.confirmGame(entry);
      await controller.deleteConfirmed();
      expect(controller.getSnapshot()).toMatchObject({
        result: page,
        deletionError: "unfinished",
        deleting: false,
      });
      controller.cancelDeletion();
      const delayed = Promise.withResolvers<{ status: "deleted" }>();
      api.clearHistory.mockImplementation(() => delayed.promise);
      controller.confirmClear();
      const first = controller.deleteConfirmed();
      await controller.deleteConfirmed();
      controller.reload();
      controller.cancelDeletion();
      expect(api.clearHistory).toHaveBeenCalledTimes(1);
      expect(api.history).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().confirmation).toBe("all");
      delayed.resolve({ status: "deleted" });
      await first;
    } finally {
      disconnect();
    }
  });
});
