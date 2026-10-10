import { describe, expect, it, vi } from "vitest";

import {
  errorResponse,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { joinedRoom, roomSession } from "../test/rooms";

import { createRoomGameApi } from "./room-game-client";

describe("room gameplay HTTP boundary", () => {
  it("sends cookie/identity-bound canonical human commands, with no provider endpoints", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(snapshot(["e2e4"], { version: 2 })));
    const identity = {
      intent: "account" as const,
      expectedAccount: roomSession.user.id,
      signal: new AbortController().signal,
      verify: vi.fn().mockResolvedValue(undefined),
    };
    const api = createRoomGameApi("http://localhost:3001", identity, fetcher);
    const command = {
      gameId: GAME_ID,
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      move: "e2e4",
    };
    await api.move(command, new AbortController().signal);
    expect(requestPath(fetcher.mock.calls[0]![0])).toBe(`/games/${GAME_ID}/moves`);
    expect(JSON.parse(requestBody(fetcher.mock.calls[0]![1]))).toEqual(command);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      credentials: "include",
      headers: {
        "x-neurochess-identity": "account",
        "x-neurochess-expected-account": roomSession.user.id,
      },
    });
  });
  it("rejects cross-game private replies and conflicts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ ...joinedRoom(), snapshot: snapshot([], { gameId: OTHER_GAME_ID }) }),
      )
      .mockResolvedValueOnce(
        errorResponse("GAME_CONFLICT", 409, snapshot([], { gameId: OTHER_GAME_ID })),
      );
    const api = createRoomGameApi(
      "http://localhost:3001",
      { intent: "guest", signal: new AbortController().signal, verify: async () => undefined },
      fetcher,
    );
    await expect(api.read(GAME_ID, new AbortController().signal)).rejects.toMatchObject({
      kind: "malformed",
    });
    await expect(
      api.move(
        { gameId: GAME_ID, commandId: crypto.randomUUID(), expectedVersion: 1, move: "e2e4" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "malformed" });
  });
  it("clears identity on authorization loss and fences late replies after cancellation", async () => {
    const abort = new AbortController();
    const lost = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse("UNAUTHORIZED", 401))
      .mockImplementationOnce(async () => {
        abort.abort();
        return jsonResponse(joinedRoom());
      });
    const api = createRoomGameApi(
      "http://localhost:3001",
      { intent: "guest", signal: abort.signal, verify: async () => undefined, lost },
      fetcher,
    );
    await expect(api.read(GAME_ID, new AbortController().signal)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(lost).toHaveBeenCalledOnce();
    await expect(api.read(GAME_ID, new AbortController().signal)).rejects.toMatchObject({
      kind: "cancelled",
    });
  });
});
