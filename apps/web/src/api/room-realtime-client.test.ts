import { afterEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, OTHER_GAME_ID } from "../test/fixtures";
import { joinedRoom, roomSession } from "../test/rooms";

import { createRoomRealtime } from "./room-realtime-client";

class Socket extends EventTarget {
  send = vi.fn();
  close = vi.fn();
  frame(value: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof value === "string" ? value : JSON.stringify(value),
      }),
    );
  }
}
afterEach(() => vi.unstubAllGlobals());
async function harness() {
  const socket = new Socket();
  const factory = vi.fn(() => socket as unknown as WebSocket);
  const abort = new AbortController();
  const lost = vi.fn();
  const identity = {
    intent: "account" as const,
    expectedAccount: roomSession.user.id,
    signal: abort.signal,
    verify: async () => undefined,
    lost,
  };
  const client = createRoomRealtime("https://api.example.com", identity, factory);
  const handlers = { message: vi.fn(), disconnected: vi.fn() };
  const close = client.connect(GAME_ID, handlers);
  await Promise.resolve();
  socket.dispatchEvent(new Event("open"));
  return { socket, factory, abort, handlers, close, lost };
}
describe("validated room realtime client", () => {
  it("sends only a protocol subscription with an observed identity over the fixed cookie URL", async () => {
    const h = await harness();
    expect(h.factory).toHaveBeenCalledWith("wss://api.example.com/rooms/realtime");
    expect(JSON.parse(h.socket.send.mock.calls[0]![0] as string)).toEqual({
      protocol: 1,
      type: "subscribe",
      gameId: GAME_ID,
      expectedIdentity: roomSession.user.id,
    });
    h.socket.frame({ protocol: 1, type: "snapshot", room: joinedRoom() });
    expect(h.handlers.message).toHaveBeenCalledWith({
      protocol: 1,
      type: "snapshot",
      room: joinedRoom(),
    });
    h.close();
  });
  it.each([
    "not-json",
    { protocol: 2, type: "access_lost" },
    { protocol: 1, type: "revision", gameId: OTHER_GAME_ID, version: 1 },
    {
      protocol: 1,
      type: "snapshot",
      room: { ...joinedRoom(), snapshot: { ...joinedRoom().snapshot, fen: "bad" } },
    },
  ])("rejects malformed or cross-game frames without forwarding data: %j", async (frame) => {
    const h = await harness();
    h.socket.frame(frame);
    expect(h.handlers.message).not.toHaveBeenCalled();
    expect(h.handlers.disconnected).toHaveBeenCalledOnce();
    expect(h.socket.close).toHaveBeenCalledOnce();
  });
  it("retires every socket callback on departure or identity loss", async () => {
    const h = await harness();
    h.abort.abort();
    h.socket.frame({ protocol: 1, type: "snapshot", room: joinedRoom() });
    h.socket.dispatchEvent(new Event("close"));
    expect(h.handlers.message).not.toHaveBeenCalled();
    expect(h.handlers.disconnected).not.toHaveBeenCalled();
    expect(h.socket.close).toHaveBeenCalledOnce();
  });
  it("forwards access loss once before closing and refreshing observed identity", async () => {
    const h = await harness();
    h.socket.frame({ protocol: 1, type: "access_lost" });
    expect(h.handlers.message).toHaveBeenCalledWith({ protocol: 1, type: "access_lost" });
    expect(h.lost).toHaveBeenCalledOnce();
    h.socket.frame({ protocol: 1, type: "snapshot", room: joinedRoom() });
    expect(h.handlers.message).toHaveBeenCalledOnce();
  });
});
