import { gameReplayResponseSchema } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { FOOLS_MATE, snapshot } from "../test/fixtures";
import { INVITATION, joinedRoom, waitingRoom } from "../test/rooms";

import { RoomStore } from "./store";

describe("room accepted state", () => {
  it("retires an issued invitation when another tab changes admission", () => {
    const store = new RoomStore();
    const room = waitingRoom();
    store.accept(room);
    store.update({ invitation: INVITATION });
    store.accept({
      ...room,
      snapshot: { ...room.snapshot, version: 1 },
      invitationAvailable: false,
    });
    expect(store.get().invitation).toBeNull();
  });
  it("requires synchronization, the assigned turn and no uncertain command before moving", () => {
    const store = new RoomStore();
    store.accept(joinedRoom());
    expect(store.get().canMove).toBe(false);
    store.update({ connection: "synchronized" });
    expect(store.get().canMove).toBe(true);
    store.update({
      pendingMove: {
        gameId: joinedRoom().snapshot.gameId,
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        move: "e2e4",
      },
    });
    expect(store.get().canMove).toBe(false);
    store.update({ pendingMove: null });
    store.accept({ ...joinedRoom(), snapshot: snapshot(["e2e4"], { version: 2 }) });
    expect(store.get().canMove).toBe(false);
  });

  it("keeps newer terminal state through old snapshots and HTTP acknowledgements", () => {
    const store = new RoomStore();
    const room = joinedRoom();
    store.accept(room);
    store.accept({ ...room, snapshot: snapshot(FOOLS_MATE, { version: 5 }) });
    expect(store.accept(room)).toBe(false);
    expect(store.acceptSnapshot(snapshot(["f2f3"], { version: 2 }))).toBe(false);
    expect(store.get().room?.snapshot.result).toBe("0-1");
    expect(store.get().canMove).toBe(false);
  });

  it("allows same-revision participant anonymization without resetting replay", () => {
    const store = new RoomStore();
    const terminal = { ...joinedRoom(), snapshot: snapshot(FOOLS_MATE, { version: 5 }) };
    store.accept(terminal);
    store.setReplay({
      replay: gameReplayResponseSchema.parse({
        snapshot: terminal.snapshot,
        initialFen: snapshot().fen,
      }),
      replayPly: 2,
      replayPhase: "idle",
      replayNotice: null,
    });
    store.accept({ ...terminal, players: { ...terminal.players, black: { kind: "deleted" } } });
    expect(store.get().room?.players.black.kind).toBe("deleted");
    expect(store.get().replayPly).toBe(2);
    store.acceptSnapshot(terminal.snapshot);
    expect(store.get().room?.players.black.kind).toBe("deleted");
  });
});
