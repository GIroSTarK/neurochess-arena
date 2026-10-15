import {
  gameReplayResponseSchema,
  type RoomServerMessage,
  type RoomView,
} from "@neurochess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiFailure, RequestRateLimitFailure } from "../api/failures";
import type { RoomGameApi } from "../api/room-game-client";
import type { RoomRealtime } from "../api/room-realtime-client";
import { FOOLS_MATE, GAME_ID, snapshot } from "../test/fixtures";
import { joinedRoom } from "../test/rooms";

import { RoomController } from "./controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(room = joinedRoom()) {
  const sessions: {
    handlers: Parameters<RoomRealtime["connect"]>[1];
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const realtime: RoomRealtime = {
    connect(_id, handlers) {
      const close = vi.fn();
      sessions.push({ handlers, close });
      return close;
    },
  };
  const api = {
    read: vi.fn<RoomGameApi["read"]>().mockResolvedValue(room),
    move: vi.fn<RoomGameApi["move"]>(),
    lifecycle: vi.fn<RoomGameApi["lifecycle"]>(),
    invitation: vi.fn<RoomGameApi["invitation"]>(),
    replay: vi.fn<RoomGameApi["replay"]>().mockImplementation(async () =>
      gameReplayResponseSchema.parse({
        initialFen: snapshot().fen,
        snapshot: controller.getSnapshot().room!.snapshot,
      }),
    ),
    pgn: vi.fn<RoomGameApi["pgn"]>(),
  };
  const delivery = { copy: vi.fn().mockResolvedValue(true), download: vi.fn() };
  const controller: RoomController = new RoomController(api, realtime, delivery);
  const frame = (message: RoomServerMessage, index = sessions.length - 1) =>
    sessions[index]!.handlers.message(message);
  const sync = (next: RoomView = room) => frame({ protocol: 1, type: "snapshot", room: next });
  controller.enter(room);
  return { controller, api, delivery, sessions, frame, sync };
}
afterEach(() => vi.useRealTimers());

describe("room controller", () => {
  it("keeps an uncertain move frozen when a reconnect snapshot cannot yet prove its outcome", async () => {
    const h = harness();
    h.sync();
    h.api.move.mockRejectedValueOnce(new ApiFailure("timeout"));
    await h.controller.move("e2e4");
    h.sessions[0]!.handlers.disconnected();
    h.controller.reconnect();
    h.sync();
    expect(h.controller.getSnapshot()).toMatchObject({
      connection: "synchronized",
      canMove: false,
      pendingMove: { move: "e2e4", expectedVersion: 1 },
    });
    expect(h.api.move).toHaveBeenCalledTimes(1);
    h.controller.endLifetime();
  });

  it("a late move response cannot roll back a terminal snapshot from a new connection", async () => {
    const h = harness();
    h.sync();
    const reply = deferred<ReturnType<typeof snapshot>>();
    h.api.move.mockReturnValue(reply.promise);
    const moving = h.controller.move("f2f3");
    h.sessions[0]!.handlers.disconnected();
    h.controller.reconnect();
    h.sync({ ...joinedRoom(), snapshot: snapshot(FOOLS_MATE, { version: 5 }) });
    reply.resolve(snapshot(["f2f3"], { version: 2 }));
    await moving;
    expect(h.controller.getSnapshot().room?.snapshot).toMatchObject({
      version: 5,
      state: "completed",
      result: "0-1",
    });
    expect(h.controller.getSnapshot().canMove).toBe(false);
    h.controller.endLifetime();
  });

  it("waits for a fresh subscription and accepts socket/HTTP races monotonically", async () => {
    const h = harness();
    await h.controller.move("e2e4");
    expect(h.api.move).not.toHaveBeenCalled();
    h.sync();
    const reply = deferred<ReturnType<typeof snapshot>>();
    h.api.move.mockReturnValue(reply.promise);
    const move = h.controller.move("e2e4");
    const newer = { ...joinedRoom(), snapshot: snapshot(["e2e4", "e7e5"], { version: 3 }) };
    h.frame({ protocol: 1, type: "update", room: newer });
    reply.resolve(snapshot(["e2e4"], { version: 2 }));
    await move;
    expect(h.controller.getSnapshot().room?.snapshot.version).toBe(3);
    expect(h.controller.getSnapshot().canMove).toBe(true);
    h.controller.endLifetime();
  });

  it.each([new ApiFailure("network"), new RequestRateLimitFailure(60)])(
    "retains the command and retries only on explicit action after a transport rejection",
    async (failure) => {
      const h = harness();
      h.sync();
      h.api.move.mockRejectedValueOnce(failure);
      await h.controller.move("e2e4");
      const sent = h.api.move.mock.calls[0]![0];
      expect(h.controller.getSnapshot()).toMatchObject({
        canMove: false,
        pendingMove: sent,
        issue: failure instanceof RequestRateLimitFailure ? "rateLimited" : "uncertain",
      });
      await h.controller.move("d2d4");
      expect(h.api.move).toHaveBeenCalledTimes(1);
      h.api.move.mockResolvedValue(snapshot(["e2e4"], { version: 2 }));
      await h.controller.retryMove();
      expect(h.api.move.mock.calls[1]![0]).toEqual(sent);
      expect(h.controller.getSnapshot().pendingMove).toBeNull();
      h.controller.endLifetime();
    },
  );

  it("a full view proves a lost move outcome without replaying it", async () => {
    const h = harness();
    h.sync();
    h.api.move.mockRejectedValue(new ApiFailure("network"));
    await h.controller.move("e2e4");
    h.sync({ ...joinedRoom(), snapshot: snapshot(["e2e4"], { version: 2 }) });
    expect(h.controller.getSnapshot().pendingMove).toBeNull();
    expect(h.api.move).toHaveBeenCalledTimes(1);
    h.controller.endLifetime();
  });

  it("reconnects with bounded backoff, fences old frames, and offers explicit retry", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sync();
    h.sessions[0]!.handlers.disconnected();
    expect(h.controller.getSnapshot()).toMatchObject({
      canMove: false,
      connection: "reconnecting",
    });
    h.frame(
      {
        protocol: 1,
        type: "update",
        room: { ...joinedRoom(), snapshot: snapshot(FOOLS_MATE, { version: 5 }) },
      },
      0,
    );
    expect(h.controller.getSnapshot().room?.snapshot.version).toBe(1);
    for (let attempt = 0; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(10_000);
      h.sessions.at(-1)!.handlers.disconnected();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.controller.getSnapshot().connection).toBe("failed");
    const count = h.sessions.length;
    h.controller.reconnect();
    expect(h.sessions.length).toBe(count + 1);
    h.sync();
    expect(h.controller.getSnapshot().canMove).toBe(true);
    h.controller.endLifetime();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resynchronizes a revision mismatch and ignores old presence sequences", () => {
    const h = harness();
    h.sync();
    h.frame({
      protocol: 1,
      type: "presence",
      gameId: GAME_ID,
      sequence: 2,
      online: { white: true, black: false },
    });
    h.frame({
      protocol: 1,
      type: "presence",
      gameId: GAME_ID,
      sequence: 1,
      online: { white: true, black: true },
    });
    expect(h.controller.getSnapshot().online?.black).toBe(false);
    expect(h.controller.getSnapshot().canMove).toBe(true);
    h.frame({ protocol: 1, type: "revision", gameId: GAME_ID, version: 2 });
    expect(h.controller.getSnapshot().canMove).toBe(false);
    h.controller.endLifetime();
  });

  it("does not reuse stale destructive decisions, even after a conflict", async () => {
    const h = harness();
    h.sync();
    await h.controller.lifecycle("resign", 0);
    expect(h.api.lifecycle).not.toHaveBeenCalled();
    h.api.lifecycle.mockRejectedValue(
      new ApiFailure("api", "GAME_CONFLICT", snapshot(["e2e4"], { version: 2 })),
    );
    await h.controller.lifecycle("resign", 1);
    expect(h.api.lifecycle.mock.calls[0]![0]).toMatchObject({
      action: "resign",
      losingColor: "white",
      expectedVersion: 1,
    });
    h.sync({ ...joinedRoom(), snapshot: snapshot(["e2e4"], { version: 2 }) });
    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
    await h.controller.lifecycle("abort", 2);
    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
    h.controller.endLifetime();
  });

  it.each(["departure", "access"])(
    "clears private state and fences pending replies on %s",
    async (kind) => {
      const h = harness();
      h.sync();
      const reply = deferred<ReturnType<typeof snapshot>>();
      h.api.move.mockReturnValue(reply.promise);
      const move = h.controller.move("e2e4");
      if (kind === "departure") h.controller.endLifetime();
      else h.frame({ protocol: 1, type: "access_lost" });
      reply.resolve(snapshot(["e2e4"], { version: 2 }));
      await move;
      h.sync();
      expect(h.controller.getSnapshot().room).toBeNull();
      expect(h.controller.getSnapshot().pendingMove).toBeNull();
      expect(h.controller.getSnapshot().invitation).toBeNull();
      expect(h.sessions[0]!.close).toHaveBeenCalled();
      expect(h.api.move.mock.calls[0]![1].aborted).toBe(true);
    },
  );

  it("loads terminal replay and private PGN through the room API", async () => {
    const h = harness();
    const terminal = { ...joinedRoom(), snapshot: snapshot(FOOLS_MATE, { version: 5 }) };
    h.sync(terminal);
    await h.controller.loadReplay();
    h.controller.selectPly(1);
    expect(h.controller.getSnapshot().replayPly).toBe(1);
    h.api.pgn.mockResolvedValue({ gameId: GAME_ID, version: 5, pgn: terminal.snapshot.pgn });
    await h.controller.exportPgn("download");
    expect(h.delivery.download).toHaveBeenCalledWith(terminal.snapshot.pgn, GAME_ID);
    expect(h.controller.getSnapshot().canMove).toBe(false);
    h.controller.endLifetime();
  });
});
