import { randomUUID } from "node:crypto";

import {
  roomIssuedResponseSchema,
  type RoomServerMessage,
  roomServerMessageSchema,
} from "@neurochess/contracts";
import { authSessions, authUsers, guestSessions } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { AUTH_COOKIE_PREFIX } from "../src/auth/constants.js";
import { createAccountAuth } from "../src/auth/service.js";
import { createRoomService } from "../src/rooms/service.js";

import { authEnvironment } from "./account-game-helpers.js";
import { createTestMailbox } from "./auth-mailbox.js";
import { type TestApi, WEB_ORIGIN } from "./helpers.js";
import { RoomApiHarness } from "./room-api-helpers.js";

const harness = new RoomApiHarness();
const sockets = new Set<WebSocket>();
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await harness.dispose();
});

describe("room transport resource boundaries", () => {
  it.each(["session", "retained_access", "profile", "verification"] as const)(
    "fences %s revoked inside the final authorization read",
    async (kind) => {
      let checking = false;
      let sessionReads = 0;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { api, owner, room } = await harness.room("white", {
        repository: (repository) => ({
          ...repository,
          read: (action) =>
            repository.read((reader) =>
              action({
                ...reader,
                async hasAccountSession(userId, sessionId) {
                  const valid = await reader.hasAccountSession(userId, sessionId);
                  if (checking && ++sessionReads === 2) {
                    checking = false;
                    entered.resolve();
                    await release.promise;
                  }
                  return valid;
                },
              }),
            ),
        }),
      });
      if (kind === "retained_access") {
        expect(
          (
            await harness.post(api, owner.cookie, `/games/${room.snapshot.gameId}/lifecycle`, {
              gameId: room.snapshot.gameId,
              expectedVersion: 0,
              commandId: randomUUID(),
              action: "abort",
            })
          ).statusCode,
        ).toBe(200);
      }
      const client = await connect(api, owner.cookie);
      checking = true;
      client.subscribe(room.snapshot.gameId, owner.principal.userId);
      try {
        await entered.promise;
        if (kind === "session") {
          await api.database.db
            .delete(authSessions)
            .where(eq(authSessions.id, owner.principal.sessionId));
        } else if (kind === "profile") {
          await api.database.db.execute(
            sql`update profiles set username = null, username_normalized = null where user_id = ${owner.principal.userId}::uuid`,
          );
        } else if (kind === "verification") {
          await api.database.db
            .update(authUsers)
            .set({ emailVerified: false })
            .where(eq(authUsers.id, owner.principal.userId));
        } else {
          expect(
            (
              await harness.post(api, owner.cookie, `/games/${room.snapshot.gameId}/delete`, {
                gameId: room.snapshot.gameId,
                confirm: true,
              })
            ).statusCode,
          ).toBe(200);
        }
      } finally {
        release.resolve();
      }
      expect(await client.next()).toEqual({ protocol: 1, type: "access_lost" });
      expect(client.messages).toHaveLength(1);
    },
  );

  it("denies protected delivery after the real password-reset endpoint revokes the bound session", async () => {
    const mailbox = createTestMailbox();
    const api = await harness.createApi({
      auth: (database, events) => createAccountAuth(database, authEnvironment, mailbox, events),
    });
    const owner = await harness.account(api);
    const operation = await harness.operation(api, owner.cookie);
    const created = await harness.post(api, owner.cookie, "/rooms", {
      operationId: operation.operationId,
      ownerColor: "black",
    });
    expect(created.statusCode).toBe(200);
    const { room, invitation } = roomIssuedResponseSchema.parse(created.json());
    const opponent = await harness.guest(api);
    await harness.join(api, opponent.cookie, invitation!, randomUUID());
    const client = await connect(api, owner.cookie);
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    await client.next();
    const [record] = await api.database.db
      .select({ email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, owner.principal.userId));
    expect(
      (await harness.post(api, "", "/api/auth/request-password-reset", { email: record!.email }))
        .statusCode,
    ).toBe(200);
    await expect.poll(() => mailbox.messages.length).toBe(1);
    const token = new URLSearchParams(mailbox.link().hash.slice(1)).get("token");
    expect(
      (
        await harness.post(api, "", "/api/auth/reset-password", {
          token,
          newPassword: "replacement-test-password-only",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await harness.post(api, opponent.cookie, `/games/${room.snapshot.gameId}/moves`, {
          gameId: room.snapshot.gameId,
          expectedVersion: 1,
          commandId: randomUUID(),
          move: "e2e4",
        })
      ).statusCode,
    ).toBe(200);
    expect(await client.next()).toEqual({ protocol: 1, type: "access_lost" });
    expect(await client.closed).toBe(1008);
    expect(client.messages).toHaveLength(2);
  });

  it("bounds an authentication handshake stalled inside a database read", async () => {
    let hold = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { api, owner } = await harness.room("white", {
      roomRealtimeLimits: { handshakeMs: 200 },
      repository: (repository) => ({
        ...repository,
        read: (action) =>
          repository.read((reader) =>
            action({
              ...reader,
              async hasAccountSession(userId, sessionId) {
                const valid = await reader.hasAccountSession(userId, sessionId);
                if (hold) {
                  hold = false;
                  entered.resolve();
                  await release.promise;
                }
                return valid;
              },
            }),
          ),
      }),
    });
    const url = await address(api);
    hold = true;
    const socket = new WebSocket(url, { headers: { cookie: owner.cookie, origin: WEB_ORIGIN } });
    sockets.add(socket);
    const messages: unknown[] = [];
    socket.on("message", (frame) => messages.push(frame));
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    try {
      await entered.promise;
      await closed;
      expect(messages).toEqual([]);
    } finally {
      release.resolve();
    }
  });

  it("enforces a global cap across identities and rejects binary/repeated subscriptions", async () => {
    const { api, owner, room } = await harness.room("white", {
      roomRealtimeLimits: { maxConnections: 2 },
    });
    const guest = await harness.guest(api);
    const ownerClient = await connect(api, owner.cookie);
    const guestClient = await connect(api, guest.cookie);
    expect(await rejectedUpgrade(api, owner.cookie, WEB_ORIGIN)).toBe(429);
    guestClient.socket.send(Buffer.from("binary"));
    expect(await guestClient.next()).toEqual({
      protocol: 1,
      type: "error",
      code: "INVALID_MESSAGE",
    });
    expect(await guestClient.closed).toBe(1008);
    ownerClient.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect(await ownerClient.next()).toMatchObject({ type: "snapshot" });
    ownerClient.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect(await ownerClient.next()).toEqual({
      protocol: 1,
      type: "error",
      code: "INVALID_MESSAGE",
    });
    expect(await ownerClient.closed).toBe(1008);
  });

  it("publishes invitation revisions without changing ply or exposing the invitation", async () => {
    const { api, owner, room, invitation } = await harness.room();
    const client = await connect(api, owner.cookie);
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    await client.next();
    expect(
      (
        await harness.post(api, owner.cookie, `/rooms/${room.snapshot.gameId}/invitation`, {
          gameId: room.snapshot.gameId,
          expectedVersion: 0,
          commandId: randomUUID(),
          action: "revoke",
        })
      ).statusCode,
    ).toBe(200);
    expect(await client.next()).toMatchObject({
      type: "update",
      room: { invitationAvailable: false, snapshot: { version: 1, moves: [] } },
    });
    expect(JSON.stringify(client.messages)).not.toContain(invitation);
  });

  it("reauthorizes after a retained-access deletion races with snapshot restoration", async () => {
    let hold = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { api, owner, room } = await harness.room("white", {
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
    expect(
      (
        await harness.post(api, owner.cookie, `/games/${room.snapshot.gameId}/lifecycle`, {
          gameId: room.snapshot.gameId,
          expectedVersion: 0,
          commandId: randomUUID(),
          action: "abort",
        })
      ).statusCode,
    ).toBe(200);
    const client = await connect(api, owner.cookie);
    hold = true;
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    try {
      await entered.promise;
      expect(
        (
          await harness.post(api, owner.cookie, `/games/${room.snapshot.gameId}/delete`, {
            gameId: room.snapshot.gameId,
            confirm: true,
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      release.resolve();
    }
    expect(await client.next()).toEqual({ protocol: 1, type: "access_lost" });
    expect(client.messages).toHaveLength(1);
  });
});

async function address(api: TestApi) {
  if (!api.app.server.listening) await api.app.listen({ host: "127.0.0.1", port: 0 });
  const bound = api.app.server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing socket address");
  return `ws://127.0.0.1:${bound.port}/rooms/realtime`;
}

async function connect(api: TestApi, cookie: string, origin = WEB_ORIGIN) {
  const socket = new WebSocket(await address(api), { headers: { cookie, origin } });
  sockets.add(socket);
  const messages: RoomServerMessage[] = [];
  let notify: (() => void) | undefined;
  socket.on("message", (data) => {
    if (!Buffer.isBuffer(data)) throw new Error("Unexpected socket frame encoding");
    messages.push(roomServerMessageSchema.parse(JSON.parse(data.toString())));
    notify?.();
  });
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let consumed = 0;
  return {
    socket,
    messages,
    closed,
    send(message: unknown) {
      socket.send(JSON.stringify(message));
    },
    subscribe(gameId: string, expectedIdentity: string) {
      socket.send(JSON.stringify({ protocol: 1, type: "subscribe", gameId, expectedIdentity }));
    },
    async next() {
      if (!messages[consumed]) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            notify = undefined;
            reject(new Error("Missing room frame"));
          }, 3000);
          notify = () => {
            clearTimeout(timer);
            notify = undefined;
            resolve();
          };
        });
      }
      return messages[consumed++]!;
    },
  };
}

async function rejectedUpgrade(api: TestApi, cookie: string, origin?: string, suffix = "") {
  const socket = new WebSocket((await address(api)) + suffix, {
    headers: { cookie, ...(origin === undefined ? {} : { origin }) },
  });
  sockets.add(socket);
  return new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.once("open", () => reject(new Error("Unexpected upgrade")));
    socket.on("error", () => undefined);
  });
}

describe("private room realtime delivery", () => {
  it.each(["account", "guest"] as const)(
    "delivers join and moves to the owner and %s with separate capabilities",
    async (kind) => {
      const { api, owner, room, invitation } = await harness.room("black");
      const opponent = kind === "account" ? await harness.account(api) : await harness.guest(api);
      const ownerSocket = await connect(api, owner.cookie);
      ownerSocket.subscribe(room.snapshot.gameId, owner.principal.userId);
      expect(await ownerSocket.next()).toMatchObject({
        protocol: 1,
        type: "snapshot",
        room: {
          state: "waiting",
          snapshot: { version: 0 },
          viewer: { color: "black", isOwner: true },
        },
      });
      const joined = await harness.join(api, opponent.cookie, invitation, randomUUID());
      expect(await ownerSocket.next()).toMatchObject({
        type: "update",
        room: { snapshot: { version: 1 }, capabilities: { canMove: false, canClose: true } },
      });
      const opponentSocket = await connect(api, opponent.cookie);
      opponentSocket.subscribe(
        room.snapshot.gameId,
        opponent.principal.kind === "account" ? opponent.principal.userId : "guest",
      );
      expect(await opponentSocket.next()).toMatchObject({
        type: "snapshot",
        room: {
          snapshot: joined.snapshot,
          viewer: { color: "white", isOwner: false },
          capabilities: { canMove: true, canClose: false },
        },
      });
      const input = {
        gameId: room.snapshot.gameId,
        commandId: randomUUID(),
        expectedVersion: 1,
        move: "e2e4",
      };
      expect(
        (await harness.post(api, opponent.cookie, `/games/${input.gameId}/moves`, input))
          .statusCode,
      ).toBe(200);
      for (const client of [ownerSocket, opponentSocket]) {
        expect(await client.next()).toMatchObject({
          type: "update",
          room: {
            snapshot: { version: 2, moves: [{ uci: "e2e4" }] },
            capabilities: { canMove: client === ownerSocket },
          },
        });
      }
      expect(
        (await harness.post(api, opponent.cookie, `/games/${input.gameId}/moves`, input))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await harness.post(api, owner.cookie, `/games/${input.gameId}/lifecycle`, {
            gameId: input.gameId,
            expectedVersion: 2,
            commandId: randomUUID(),
            action: "abort",
          })
        ).statusCode,
      ).toBe(200);
      for (const client of [ownerSocket, opponentSocket]) {
        expect(await client.next()).toMatchObject({
          type: "update",
          room: { snapshot: { version: 3, state: "aborted" } },
        });
        expect(
          client.messages
            .filter((message) => message.type === "update")
            .map((message) => message.room.snapshot.version),
        ).toEqual(client === ownerSocket ? [1, 2, 3] : [2, 3]);
      }
    },
  );

  it("rejects absent/foreign Origin, missing authority, incomplete profiles and secret-bearing URLs", async () => {
    const { api, owner } = await harness.room();
    for (const origin of [undefined, "null", WEB_ORIGIN + ".evil", "https://localhost:5173"]) {
      expect(await rejectedUpgrade(api, owner.cookie, origin)).toBe(403);
    }
    expect(await rejectedUpgrade(api, "", WEB_ORIGIN)).toBe(401);
    const incomplete = await harness.account(api, false);
    expect(await rejectedUpgrade(api, incomplete.cookie, WEB_ORIGIN)).toBe(403);
    expect(await rejectedUpgrade(api, owner.cookie, WEB_ORIGIN, "?invite=secret")).toBe(400);
  });

  it("denies outsiders and identity mismatches without disclosing private state", async () => {
    const { api, owner, room } = await harness.room();
    const outsider = await harness.account(api);
    for (const [cookie, identity] of [
      [outsider.cookie, outsider.principal.userId],
      [owner.cookie, outsider.principal.userId],
      [owner.cookie, "guest"],
    ] as const) {
      const client = await connect(api, cookie);
      client.subscribe(room.snapshot.gameId, identity);
      expect(await client.next()).toEqual({ protocol: 1, type: "access_lost" });
      expect(await client.closed).toBe(1008);
      expect(client.messages).toHaveLength(1);
    }
  });

  it.each([
    { protocol: 2, type: "subscribe", gameId: randomUUID(), expectedIdentity: "guest" },
    {
      protocol: 1,
      type: "subscribe",
      gameId: randomUUID(),
      expectedIdentity: "guest",
      invitation: "secret",
    },
    { protocol: 1, type: "move", move: "e2e4" },
  ])("closes on invalid subscription %# without echoing payloads", async (message) => {
    const { api, owner } = await harness.room();
    const client = await connect(api, owner.cookie);
    client.send(message);
    expect(await client.next()).toEqual({ protocol: 1, type: "error", code: "INVALID_MESSAGE" });
    expect(await client.closed).toBe(1008);
  });

  it("closes malformed and oversized frames", async () => {
    const { api, owner } = await harness.room();
    const invalid = await connect(api, owner.cookie);
    invalid.socket.send("{not json secret");
    expect(await invalid.next()).toEqual({ protocol: 1, type: "error", code: "INVALID_MESSAGE" });
    const oversized = await connect(api, owner.cookie);
    oversized.socket.send("x".repeat(4097));
    expect(await oversized.closed).toBe(1009);
    expect(oversized.messages).toEqual([]);
  });

  it("uses account precedence and never falls back from an invalid account cookie to a valid guest", async () => {
    const { api, owner, room, invitation } = await harness.room();
    const guest = await harness.guest(api);
    await harness.join(api, guest.cookie, invitation, randomUUID());
    const both = await connect(api, `${owner.cookie}; ${guest.cookie}`);
    both.subscribe(room.snapshot.gameId, "guest");
    expect(await both.next()).toEqual({ protocol: 1, type: "access_lost" });
    expect(
      await rejectedUpgrade(
        api,
        `${AUTH_COOKIE_PREFIX}.session_token=invalid; ${guest.cookie}`,
        WEB_ORIGIN,
      ),
    ).toBe(401);
    await api.database.db
      .update(authUsers)
      .set({ emailVerified: false })
      .where(eq(authUsers.id, owner.principal.userId));
    expect(await rejectedUpgrade(api, owner.cookie, WEB_ORIGIN)).toBe(403);
  });

  it("buffers a committed move during baseline restoration, then delivers it after the baseline", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const { api, owner, invitation, room } = await harness.room("white", {
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
    const opponent = await harness.guest(api);
    await harness.join(api, opponent.cookie, invitation, randomUUID());
    const client = await connect(api, owner.cookie);
    hold = true;
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    try {
      await entered.promise;
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
      expect(client.messages).toEqual([]);
    } finally {
      release.resolve();
    }
    expect(await client.next()).toMatchObject({
      type: "snapshot",
      room: { snapshot: { version: 1, moves: [] } },
    });
    expect(await client.next()).toMatchObject({
      type: "update",
      room: { snapshot: { version: 2, moves: [{ uci: "e2e4" }] } },
    });
  });

  it("does not publish an inserted move until commit, and a rollback publishes nothing", async () => {
    let fail = false;
    let block = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { api, owner, invitation, room } = await harness.room("white", {
      repository: (repository) => ({
        ...repository,
        write: (action) =>
          repository.write((tx) =>
            action({
              ...tx,
              async appendMove(input) {
                await tx.appendMove(input);
                if (fail) throw new Error("Injected rollback");
                if (block) {
                  block = false;
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
    const client = await connect(api, guest.cookie);
    client.subscribe(room.snapshot.gameId, "guest");
    await client.next();
    const command = {
      gameId: room.snapshot.gameId,
      commandId: randomUUID(),
      expectedVersion: 1,
      move: "e2e4",
    };
    fail = true;
    expect(
      (await harness.post(api, owner.cookie, `/games/${command.gameId}/moves`, command)).statusCode,
    ).toBe(500);
    expect((await harness.view(api, owner.cookie, command.gameId)).snapshot.version).toBe(1);
    fail = false;
    block = true;
    const committing = harness.post(api, owner.cookie, `/games/${command.gameId}/moves`, command);
    try {
      await entered.promise;
      expect((await harness.view(api, owner.cookie, command.gameId)).snapshot.version).toBe(1);
      expect(client.messages).toHaveLength(1);
    } finally {
      release.resolve();
    }
    expect((await committing).statusCode).toBe(200);
    expect(await client.next()).toMatchObject({
      type: "update",
      room: { snapshot: { version: 2, moves: [{ uci: "e2e4" }] } },
    });
    expect(client.messages).toHaveLength(2);
  });

  it.each(["revoke", "expire", "guest_expire"] as const)(
    "rechecks %s before delivering a committed update",
    async (kind) => {
      const { api, owner, invitation, room } = await harness.room();
      const opponent =
        kind === "guest_expire" ? await harness.guest(api) : await harness.account(api);
      await harness.join(api, opponent.cookie, invitation, randomUUID());
      const client = await connect(api, opponent.cookie);
      client.subscribe(
        room.snapshot.gameId,
        opponent.principal.kind === "account" ? opponent.principal.userId : "guest",
      );
      await client.next();
      if (opponent.principal.kind === "guest") {
        await api.database.db
          .update(guestSessions)
          .set({
            createdAt: sql`clock_timestamp() - interval '3 seconds'`,
            lastSeenAt: sql`clock_timestamp() - interval '2 seconds'`,
            expiresAt: sql`clock_timestamp() - interval '1 second'`,
          })
          .where(eq(guestSessions.id, opponent.principal.guestSessionId));
      } else if (kind === "expire") {
        await api.database.db
          .update(authSessions)
          .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(authSessions.id, opponent.principal.sessionId));
      } else {
        expect(
          (await harness.post(api, opponent.cookie, "/api/auth/sign-out", {})).statusCode,
        ).toBe(200);
        if ("anotherSession" in opponent) await opponent.anotherSession();
      }
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
      expect(await client.next()).toEqual({ protocol: 1, type: "access_lost" });
      expect(await client.closed).toBe(1008);
      expect(client.messages).toHaveLength(2);
    },
  );

  it("fences a session revoked during a repeatable-read snapshot", async () => {
    let hold = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { api, owner, room } = await harness.room("white", {
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
    const client = await connect(api, owner.cookie);
    hold = true;
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    try {
      await entered.promise;
      await api.database.db
        .delete(authSessions)
        .where(eq(authSessions.id, owner.principal.sessionId));
    } finally {
      release.resolve();
    }
    expect(await client.next()).toEqual({ protocol: 1, type: "access_lost" });
    expect(client.messages).toHaveLength(1);
  });

  it.each(["delete", "clear"] as const)(
    "publishes resignation, then fences retained access after history %s",
    async (action) => {
      const { api, owner, invitation, room } = await harness.room();
      const opponent = await harness.account(api);
      await harness.join(api, opponent.cookie, invitation, randomUUID());
      const client = await connect(api, opponent.cookie);
      client.subscribe(room.snapshot.gameId, opponent.principal.userId);
      await client.next();
      expect(
        (
          await harness.post(api, opponent.cookie, `/games/${room.snapshot.gameId}/lifecycle`, {
            gameId: room.snapshot.gameId,
            expectedVersion: 1,
            commandId: randomUUID(),
            action: "resign",
            losingColor: "black",
          })
        ).statusCode,
      ).toBe(200);
      expect(await client.next()).toMatchObject({
        type: "update",
        room: {
          snapshot: { version: 2, state: "completed", terminationReason: "human_resignation" },
        },
      });
      expect(
        (
          await harness.post(
            api,
            opponent.cookie,
            action === "delete" ? `/games/${room.snapshot.gameId}/delete` : "/games/history/clear",
            action === "delete"
              ? { gameId: room.snapshot.gameId, confirm: true }
              : { confirm: true },
          )
        ).statusCode,
      ).toBe(200);
      expect(await client.next()).toEqual({ protocol: 1, type: "access_lost" });
      expect(await client.closed).toBe(1008);
      expect((await harness.view(api, owner.cookie, room.snapshot.gameId)).snapshot.state).toBe(
        "completed",
      );
    },
  );

  it("publishes an account-deletion abort only to the remaining participant", async () => {
    const { api, owner, invitation, room } = await harness.room();
    const opponent = await harness.account(api);
    await harness.join(api, opponent.cookie, invitation, randomUUID());
    const clients = await Promise.all([connect(api, owner.cookie), connect(api, opponent.cookie)]);
    for (const [index, client] of clients.entries()) {
      client.subscribe(room.snapshot.gameId, (index ? opponent : owner).principal.userId);
      await client.next();
    }
    expect(
      (await harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true }))
        .statusCode,
    ).toBe(200);
    expect(await clients[0].next()).toEqual({ protocol: 1, type: "access_lost" });
    expect(await clients[1].next()).toMatchObject({
      type: "update",
      room: { players: { white: { kind: "deleted" } }, snapshot: { version: 2, state: "aborted" } },
    });
  });

  it("bounds subscription time and releases capacity on close", async () => {
    const { api, owner, room } = await harness.room("white", {
      roomRealtimeLimits: { subscriptionMs: 100, maxConnectionsPerIdentity: 1, maxConnections: 2 },
    });
    const client = await connect(api, owner.cookie);
    expect(await rejectedUpgrade(api, owner.cookie, WEB_ORIGIN)).toBe(429);
    expect(await client.closed).toBe(1008);
    const next = await connect(api, owner.cookie);
    next.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect(await next.next()).toMatchObject({ type: "snapshot" });
  });

  it("closes an outbound frame exceeding the buffer budget and disposes sockets on app close", async () => {
    const { api, owner, room } = await harness.room("white", {
      roomRealtimeLimits: { maxBufferedBytes: 32 },
    });
    const client = await connect(api, owner.cookie);
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect(await client.closed).toBe(1013);
    expect(client.messages).toEqual([]);
    const waiting = await connect(api, owner.cookie);
    await api.app.close();
    await waiting.closed;
    expect(waiting.messages).toEqual([]);
  });

  it("deduplicates join retries and does not turn delivery failure into a failed committed command", async () => {
    const { api, owner, invitation, room } = await harness.room();
    const opponent = await harness.guest(api);
    const client = await connect(api, owner.cookie);
    client.subscribe(room.snapshot.gameId, owner.principal.userId);
    await client.next();
    const commandId = randomUUID();
    await harness.join(api, opponent.cookie, invitation, commandId);
    expect(await client.next()).toMatchObject({
      type: "update",
      room: { snapshot: { version: 1 } },
    });
    await harness.join(api, opponent.cookie, invitation, commandId);
    const unsubscribe = api.roomEvents.subscribe(() => {
      throw new Error("Injected publisher failure");
    });
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
    } finally {
      unsubscribe();
    }
    expect(await client.next()).toMatchObject({
      type: "update",
      room: { snapshot: { version: 2 } },
    });
    expect(client.messages).toHaveLength(3);
    const service = createRoomService(api.repository);
    expect((await service.read(opponent.principal, room.snapshot.gameId)).snapshot.version).toBe(2);
  });
});
