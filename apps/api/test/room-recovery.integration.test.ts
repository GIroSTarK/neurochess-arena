import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { RoomSocketHarness } from "./room-socket-helpers.js";

const harness = new RoomSocketHarness();
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await harness.dispose();
});

describe("room transport recovery", () => {
  it("counts participant tabs independently of game revisions and survives both players disconnecting", async () => {
    const { api, owner, room, invitation } = await harness.room("black", {
      roomRealtimeLimits: { reconciliationMs: 100 },
    });
    const guest = await harness.guest(api);
    const joined = await harness.join(api, guest.cookie, invitation, randomUUID());
    const first = await harness.connect(api, owner.cookie);
    first.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect((await first.next("snapshot")).room.snapshot).toEqual(joined.snapshot);
    expect(await first.next("presence")).toMatchObject({
      sequence: 1,
      online: { white: false, black: true },
    });
    const second = await harness.connect(api, owner.cookie);
    second.subscribe(room.snapshot.gameId, owner.principal.userId);
    await second.next("snapshot");
    expect((await second.next("presence")).online).toEqual({ white: false, black: true });
    const opponent = await harness.connect(api, guest.cookie);
    opponent.subscribe(room.snapshot.gameId, "guest");
    await opponent.next("snapshot");
    expect((await opponent.next("presence")).online).toEqual({ white: true, black: true });
    expect(await second.next("presence")).toMatchObject({
      sequence: 2,
      online: { white: true, black: true },
    });
    first.socket.close();
    await first.closed;
    await second.next("revision");
    expect(second.messages.filter((message) => message.type === "presence")).toHaveLength(2);
    second.socket.terminate();
    await second.closed;
    expect((await opponent.next("presence")).online).toEqual({ white: true, black: false });
    opponent.socket.terminate();
    await opponent.closed;
    expect((await harness.view(api, owner.cookie, room.snapshot.gameId)).snapshot).toEqual(
      joined.snapshot,
    );
    const returned = await harness.connect(api, owner.cookie);
    returned.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect((await returned.next("snapshot")).room.snapshot).toEqual(joined.snapshot);
    expect(await returned.next("presence")).toMatchObject({
      sequence: 1,
      online: { white: false, black: true },
    });
  });

  it("recovers a committed move with lost publication without another move and ignores duplicate invalidations", async () => {
    const { api, owner, room, invitation } = await harness.room("white", {
      roomRealtimeLimits: { reconciliationMs: 100 },
    });
    const guest = await harness.guest(api);
    await harness.join(api, guest.cookie, invitation, randomUUID());
    const client = await harness.connect(api, guest.cookie);
    client.subscribe(room.snapshot.gameId, "guest");
    await client.next("snapshot");
    await client.next("revision");
    const publish = vi.spyOn(api.roomEvents, "publish").mockImplementation(() => undefined);
    const command = {
      gameId: room.snapshot.gameId,
      expectedVersion: 1,
      commandId: randomUUID(),
      move: "e2e4",
    };
    expect(
      (await harness.post(api, owner.cookie, `/games/${command.gameId}/moves`, command)).statusCode,
    ).toBe(200);
    expect((await client.next("snapshot")).room.snapshot).toMatchObject({
      version: 2,
      state: "active",
      moves: [{ uci: "e2e4" }],
    });
    publish.mockRestore();
    api.roomEvents.publish(command.gameId);
    api.roomEvents.publish(randomUUID());
    api.roomEvents.publish(command.gameId);
    await expect
      .poll(
        () =>
          client.messages.filter((message) => message.type === "revision" && message.version === 2)
            .length,
      )
      .toBeGreaterThan(0);
    expect(client.messages.filter((message) => "room" in message)).toHaveLength(2);
    expect(
      (await harness.post(api, owner.cookie, `/games/${command.gameId}/moves`, command)).statusCode,
    ).toBe(409);
    expect((await harness.view(api, guest.cookie, command.gameId)).snapshot.moves).toHaveLength(1);
  });

  it("terminates a half-open peer that does not answer the probe and releases its capacity", async () => {
    const { api, owner, room } = await harness.room("white", {
      roomRealtimeLimits: { heartbeatMs: 100, pongTimeoutMs: 100, maxConnectionsPerIdentity: 1 },
    });
    const client = await harness.connect(api, owner.cookie, { autoPong: false });
    client.socket.on("ping", () => client.socket.pong("wrong-probe"));
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    await client.next("snapshot");
    expect(await client.closed).toBe(1006);
    const returned = await harness.connect(api, owner.cookie);
    returned.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect((await returned.next("snapshot")).room.snapshot).toEqual(room.snapshot);
  });

  it("keeps a responsive connection alive across repeated transport probes", async () => {
    const { api, owner, room } = await harness.room("white", {
      roomRealtimeLimits: { heartbeatMs: 50, pongTimeoutMs: 100, reconciliationMs: 50 },
    });
    const client = await harness.connect(api, owner.cookie);
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    await client.next("snapshot");
    for (let probe = 0; probe < 3; probe++) await once(client.socket, "ping");
    expect(client.socket.readyState).toBe(client.socket.OPEN);
    expect((await harness.view(api, owner.cookie, room.snapshot.gameId)).snapshot).toEqual(
      room.snapshot,
    );
  });

  it("restores committed history in a new API process after a crash and restores an offline owner's abort", async () => {
    const { api, owner, room, invitation } = await harness.room();
    const guest = await harness.guest(api);
    await harness.join(api, guest.cookie, invitation, randomUUID());
    const command = {
      gameId: room.snapshot.gameId,
      expectedVersion: 1,
      commandId: randomUUID(),
      move: "e2e4",
    };
    expect(
      (await harness.post(api, owner.cookie, `/games/${command.gameId}/moves`, command)).statusCode,
    ).toBe(200);
    const accepted = (await harness.view(api, guest.cookie, command.gameId)).snapshot;
    await api.app.close();

    async function processSnapshot() {
      const child = fork(fileURLToPath(new URL("./room-recovery-server.ts", import.meta.url)), [], {
        execArgv: ["--conditions=development", "--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
      const exited = once(child, "exit");
      try {
        const address: unknown = (
          await Promise.race([
            once(child, "message", { signal: AbortSignal.timeout(5000) }),
            exited.then(() => {
              throw new Error("Room process exited before listening");
            }),
          ])
        )[0];
        if (
          typeof address !== "string" ||
          !/^ws:\/\/127\.0\.0\.1:\d+\/rooms\/realtime$/.test(address)
        ) {
          throw new Error("Invalid room process address");
        }
        const client = await harness.connect(address, guest.cookie);
        client.subscribe(command.gameId, "guest");
        const snapshot = (await client.next("snapshot")).room.snapshot;
        expect((await client.next("presence")).online).toEqual({ white: false, black: true });
        return snapshot;
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    }
    expect(await processSnapshot()).toEqual(accepted);
    const restarted = await harness.createAuthenticatedApi();
    expect(
      (await harness.post(restarted, owner.cookie, `/games/${command.gameId}/moves`, command))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await harness.post(restarted, owner.cookie, `/games/${command.gameId}/lifecycle`, {
          gameId: command.gameId,
          expectedVersion: 2,
          commandId: randomUUID(),
          action: "abort",
        })
      ).statusCode,
    ).toBe(200);
    expect(await processSnapshot()).toMatchObject({
      version: 3,
      state: "aborted",
      moves: [{ uci: "e2e4" }],
    });
  });

  it("reconnects during a move transaction and never duplicates the move after a lost acknowledgement", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const { api, owner, room, invitation } = await harness.room("white", {
      repository: (repository) => ({
        ...repository,
        write: (action) =>
          repository.write((tx) =>
            action({
              ...tx,
              async appendMove(input) {
                await tx.appendMove(input);
                if (hold) {
                  hold = false;
                  entered.resolve();
                  await release.promise;
                }
              },
            }),
          ),
      }),
    });
    const guest = await harness.guest(api);
    await harness.join(api, guest.cookie, invitation, randomUUID());
    const old = await harness.connect(api, guest.cookie);
    old.subscribe(room.snapshot.gameId, "guest");
    await old.next("snapshot");
    const command = {
      gameId: room.snapshot.gameId,
      expectedVersion: 1,
      commandId: randomUUID(),
      move: "e2e4",
    };
    hold = true;
    const moving = harness.post(api, owner.cookie, `/games/${command.gameId}/moves`, command);
    let returned: Awaited<ReturnType<typeof harness.connect>>;
    try {
      await entered.promise;
      old.socket.terminate();
      await old.closed;
      returned = await harness.connect(api, guest.cookie);
      returned.subscribe(command.gameId, "guest");
      expect((await returned.next("snapshot")).room.snapshot).toMatchObject({
        version: 1,
        moves: [],
      });
    } finally {
      release.resolve();
    }
    expect((await moving).statusCode).toBe(200);
    expect((await returned.next("update")).room.snapshot).toMatchObject({
      version: 2,
      moves: [{ uci: "e2e4" }],
    });
    expect(
      (await harness.post(api, owner.cookie, `/games/${command.gameId}/moves`, command)).statusCode,
    ).toBe(409);
    expect(old.messages.filter((message) => "room" in message)).toHaveLength(1);
    expect((await harness.view(api, guest.cookie, command.gameId)).snapshot.moves).toHaveLength(1);
  });

  it("closes an established slow connection and restores the accepted move on a fresh connection", async () => {
    const { api, owner, room, invitation } = await harness.room();
    const guest = await harness.guest(api);
    await harness.join(api, guest.cookie, invitation, randomUUID());
    const client = await harness.connect(api, guest.cookie);
    client.subscribe(room.snapshot.gameId, "guest");
    await client.next("snapshot");
    const buffer = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockReturnValue(1024 * 1024);
    try {
      expect(
        (
          await harness.post(api, owner.cookie, `/games/${room.snapshot.gameId}/moves`, {
            gameId: room.snapshot.gameId,
            expectedVersion: 1,
            commandId: randomUUID(),
            move: "e2e4",
          })
        ).statusCode,
      ).toBe(200);
      expect(await client.closed).toBe(1013);
    } finally {
      buffer.mockRestore();
    }
    const returned = await harness.connect(api, guest.cookie);
    returned.subscribe(room.snapshot.gameId, "guest");
    expect((await returned.next("snapshot")).room.snapshot).toMatchObject({
      version: 2,
      moves: [{ uci: "e2e4" }],
    });
    expect(client.messages.filter((message) => "room" in message)).toHaveLength(1);
  });

  it("disposes live connections, heartbeat and reconciliation timers on application shutdown", async () => {
    const { api, owner, room } = await harness.room();
    await harness.address(api);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const client = await harness.connect(api, owner.cookie);
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    await client.next("snapshot");
    await client.next("presence");
    await harness.close(api);
    await client.closed;
    const delivered = client.messages.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.messages).toHaveLength(delivered);
    vi.useRealTimers();
  });

  it("bounds a stalled reconciliation and fences its late snapshot after reconnection", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const { api, owner, room } = await harness.room("white", {
      roomRealtimeLimits: { reconciliationMs: 100, deliveryMs: 100 },
      repository: (repository) => ({
        ...repository,
        read: (action) =>
          repository.read((reader) =>
            action({
              ...reader,
              async getMoves(id) {
                const moves = await reader.getMoves(id);
                if (hold) {
                  hold = false;
                  entered.resolve();
                  await release.promise;
                }
                return moves;
              },
            }),
          ),
      }),
    });
    const old = await harness.connect(api, owner.cookie);
    old.subscribe(room.snapshot.gameId, owner.principal.userId);
    await old.next("snapshot");
    await old.next("revision");
    hold = true;
    try {
      await entered.promise;
      expect(await old.closed).toBe(1013);
    } finally {
      release.resolve();
    }
    const returned = await harness.connect(api, owner.cookie);
    returned.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect((await returned.next("snapshot")).room.snapshot).toEqual(room.snapshot);
    expect(old.messages.filter((message) => "room" in message)).toHaveLength(1);
  });
});
