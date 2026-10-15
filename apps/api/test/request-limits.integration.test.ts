import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { analysisSample } from "./analysis-helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { turnCatalog } from "./providers/turn-catalog.js";
import { RoomSocketHarness } from "./room-socket-helpers.js";

const harness = new RoomSocketHarness();
afterEach(async () => {
  await harness.dispose();
  vi.restoreAllMocks();
});

describe("production request and socket limits", () => {
  it("rejects an AI turn before discovery or paid dispatch without changing the active game", async () => {
    const adapter = createScriptedAdapter({ provider: "openai" });
    const api = await harness.createAuthenticatedApi({
      aiAdapters: { openai: adapter },
      requestLimits: { policies: { commands: { ip: 100, principal: 1, inFlight: 4 } } },
    });
    const account = await harness.account(api);
    const game = await harness.createGame(api, account.cookie);
    const gameId = game.snapshot.gameId;
    const controllerId = randomUUID();
    expect(
      (
        await harness.post(api, account.cookie, `/games/${gameId}/controller`, {
          gameId,
          controllerId,
          expectedVersion: game.snapshot.version,
          action: "acquire",
        })
      ).statusCode,
    ).toBe(200);
    const command = { gameId, commandId: randomUUID(), expectedVersion: game.snapshot.version };
    // A rejected human command also spends the caller's command budget.
    expect(
      (
        await harness.post(api, account.cookie, `/games/${gameId}/moves`, {
          ...command,
          move: "e2e4",
        })
      ).statusCode,
    ).toBe(403);
    const limited = await harness.post(api, account.cookie, `/games/${gameId}/ai-turn`, {
      ...command,
      commandId: randomUUID(),
      controllerId,
      apiKey: "private-dispatch-canary",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.body).not.toContain("private-dispatch-canary");
    expect(adapter.discoveryCalls).toBe(0);
    expect(adapter.moveCalls).toBe(0);
    const snapshot = await api.app.inject({
      url: `/games/${gameId}`,
      headers: { cookie: account.cookie },
    });
    expect(snapshot.json()).toEqual(game.snapshot);
  });
  it("blocks discovery before upstream work across account sessions and changing IPs", async () => {
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [{ ok: true, models: turnCatalog("openai") }],
    });
    const api = await harness.createAuthenticatedApi({
      aiAdapters: { openai: adapter },
      requestLimits: { policies: { discovery: { ip: 100, principal: 1, inFlight: 4 } } },
    });
    const account = await harness.account(api);
    const another = await account.anotherSession();
    const payload = { provider: "openai", apiKey: "private-provider-key" };
    expect((await harness.post(api, account.cookie, "/providers/models", payload)).statusCode).toBe(
      200,
    );
    const rejected = await api.app.inject({
      method: "POST",
      url: "/providers/models",
      remoteAddress: "192.0.2.19",
      headers: {
        origin: "http://localhost:5173",
        cookie: another.cookie,
        "x-neurochess-expected-account": account.principal.userId,
      },
      payload,
    });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(rejected.body).not.toContain(payload.apiKey);
    expect(adapter.discoveryCalls).toBe(1);
    expect(adapter.moveCalls).toBe(0);
  });

  it("permits eight tabs' burst of room reads, analysis pages and uploads without spending control capacity", async () => {
    const { api, owner, room } = await harness.room();
    const id = room.snapshot.gameId;
    const sample = analysisSample(room.snapshot);
    const version = room.snapshot.version;
    // Twenty polling cycles per tab is a minute at the browser's three-second cadence.
    for (let cycle = 0; cycle < 20; cycle++) {
      const results = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const read = await api.app.inject({
            url: `/rooms/${id}`,
            headers: { cookie: owner.cookie },
          });
          const analysis = await api.app.inject({
            url: `/games/${id}/analysis`,
            headers: { cookie: owner.cookie },
          });
          const upload = await harness.post(api, owner.cookie, `/games/${id}/analysis`, {
            samples: [sample],
          });
          return [read.statusCode, analysis.statusCode, upload.statusCode];
        }),
      );
      expect(results.flat()).toEqual(Array<number>(24).fill(200));
    }
    expect((await harness.view(api, owner.cookie, id)).snapshot.version).toBe(version);
    expect(
      (
        await harness.post(api, owner.cookie, `/games/${id}/lifecycle`, {
          gameId: id,
          expectedVersion: version,
          commandId: randomUUID(),
          action: "abort",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("bounds fragmented subscriptions before accepting a complete application message", async () => {
    const { api, owner } = await harness.room();
    const client = await harness.connect(api, owner.cookie);
    for (let i = 0; i < 33; i++) client.socket.send(" ", { fin: false });
    expect(await client.closed).toBe(1008);
    expect(client.messages).toHaveLength(0);
  });

  it("retains the AI lease through eight tabs' invocation polling and a full minute of heartbeats", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const game = await harness.createGame(api, account.cookie);
    const gameId = game.snapshot.gameId;
    const controllerId = randomUUID();
    expect(
      (
        await harness.post(api, account.cookie, `/games/${gameId}/controller`, {
          gameId,
          controllerId,
          expectedVersion: game.snapshot.version,
          action: "acquire",
        })
      ).statusCode,
    ).toBe(200);
    for (let cycle = 0; cycle < 20; cycle++) {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          api.app.inject({
            url: `/games/${gameId}/invocations`,
            headers: { cookie: account.cookie },
          }),
        ),
      );
      expect(responses.map((response) => response.statusCode)).toEqual(Array<number>(8).fill(200));
      const heartbeat = await harness.post(api, account.cookie, `/games/${gameId}/controller`, {
        gameId,
        controllerId,
        action: "heartbeat",
      });
      expect(heartbeat.statusCode).toBe(200);
      expect(heartbeat.json()).toMatchObject({ state: "active", version: game.snapshot.version });
    }
  });
  it("keeps both NAT participants' eight tabs subscribed and permits a reconnect burst", async () => {
    const { api, owner, room, invitation } = await harness.room();
    const opponent = await harness.guest(api);
    await harness.join(api, opponent.cookie, invitation, randomUUID());
    const clients = [];
    for (const participant of [owner, opponent]) {
      for (let tab = 0; tab < 8; tab++) {
        const client = await harness.connect(api, participant.cookie);
        client.subscribe(
          room.snapshot.gameId,
          participant.principal.kind === "account" ? participant.principal.userId : "guest",
        );
        await client.next("snapshot");
        clients.push(client);
      }
    }
    expect(await harness.rejectedUpgrade(api, owner.cookie)).toBe(429);
    for (const client of clients) client.socket.close();
    await Promise.all(clients.map((client) => client.closed));
    for (let tab = 0; tab < 8; tab++) {
      const client = await harness.connect(api, owner.cookie);
      client.subscribe(room.snapshot.gameId, owner.principal.userId);
      await client.next("snapshot");
    }
    expect((await harness.view(api, owner.cookie, room.snapshot.gameId)).snapshot.state).toBe(
      "active",
    );
  });

  it("closes control-frame floods while preserving another participant's connection", async () => {
    const { api, owner, room, invitation } = await harness.room("white", {
      roomRealtimeLimits: { maxControlFramesPerWindow: 4 },
    });
    const opponent = await harness.guest(api);
    await harness.join(api, opponent.cookie, invitation, randomUUID());
    const attacker = await harness.connect(api, owner.cookie);
    const peer = await harness.connect(api, opponent.cookie);
    attacker.subscribe(room.snapshot.gameId, owner.principal.userId);
    peer.subscribe(room.snapshot.gameId, "guest");
    await Promise.all([attacker.next("snapshot"), peer.next("snapshot")]);
    for (let i = 0; i < 5; i++) attacker.socket.ping("private-payload");
    expect(await attacker.closed).toBe(1008);
    expect(peer.socket.readyState).toBe(peer.socket.OPEN);
    expect((await harness.view(api, owner.cookie, room.snapshot.gameId)).snapshot.state).toBe(
      "active",
    );
  });

  it("caps all connections from one address before authentication and reclaims closed slots", async () => {
    const { api, owner, room } = await harness.room("white", {
      roomRealtimeLimits: { maxConnectionsPerIp: 1 },
    });
    const client = await harness.connect(api, owner.cookie);
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    await client.next("snapshot");
    expect(await harness.rejectedUpgrade(api, "forged-cookie")).toBe(429);
    client.socket.close();
    await client.closed;
    const replacement = await harness.connect(api, owner.cookie);
    replacement.subscribe(room.snapshot.gameId, owner.principal.userId);
    await replacement.next("snapshot");
  });
});
