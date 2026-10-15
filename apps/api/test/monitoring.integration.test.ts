import { operationsSnapshotSchema } from "@neurochess/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { RoomSocketHarness } from "./room-socket-helpers.js";

const harness = new RoomSocketHarness();
afterEach(() => harness.dispose());

describe("operational room fault drill", () => {
  it("detects failed resynchronization and recovers after socket churn without private labels", async () => {
    let failReads = false;
    const { api, owner, room } = await harness.room("white", {
      repository: (repository) => ({
        ...repository,
        read: (action) => {
          if (failReads) return Promise.reject(new Error("private-database-failure-canary"));
          return repository.read(action);
        },
      }),
    });
    const first = await harness.connect(api, owner.cookie);
    failReads = true;
    first.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect(await first.closed).toBe(1011);
    failReads = false;
    for (let i = 0; i < 3; i++) {
      const client = await harness.connect(api, owner.cookie);
      client.subscribe(room.snapshot.gameId, owner.principal.userId);
      expect((await client.next("snapshot")).room.snapshot.gameId).toBe(room.snapshot.gameId);
      client.socket.close();
      await client.closed;
    }
    const snapshot = await api.app.inject("/internal/operations");
    expect(operationsSnapshotSchema.parse(snapshot.json()).counters).toMatchObject({
      roomAccepted: 4,
      roomClosed: 4,
      roomFailures: 1,
      roomSynchronized: 3,
    });
    expect(operationsSnapshotSchema.parse(snapshot.json()).gauges.roomConnections).toBe(0);
    for (const privateValue of [
      room.snapshot.gameId,
      owner.principal.userId,
      owner.cookie,
      "canary",
    ]) {
      expect(snapshot.body).not.toContain(privateValue);
    }
  });
});
