import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import { roomIssuedResponseSchema } from "@neurochess/contracts";
import {
  authSessions,
  authUsers,
  gameParticipants,
  games,
  gameSlots,
  roomCreationOperations,
  roomHistoryAccess,
} from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { command, WEB_ORIGIN } from "./helpers.js";
import { RoomApiHarness } from "./room-api-helpers.js";

const harness = new RoomApiHarness();
afterEach(() => harness.dispose());

describe("private room HTTP admission", () => {
  it.each(["white", "black"] as const)(
    "creates a standard waiting room for a %s owner",
    async (ownerColor) => {
      const { api, owner, room, invitation, operation, payload } = await harness.room(ownerColor);
      expect(room).toMatchObject({
        state: "waiting",
        ownerColor,
        invitationAvailable: true,
        viewer: { color: ownerColor, isOwner: true },
        capabilities: {
          canMove: false,
          canResign: false,
          canClose: true,
          canManageInvitation: true,
        },
        snapshot: {
          state: "paused",
          version: 0,
          turn: "white",
          moves: [],
          fen: createGame().snapshot().fen,
        },
      });
      expect(Buffer.from(invitation, "base64url")).toHaveLength(32);
      const stored = await api.repository.read((reader) => reader.getRoom(room.snapshot.gameId));
      expect(stored?.invitationDigest).toBe(createHash("sha256").update(invitation).digest("hex"));
      expect(JSON.stringify(stored)).not.toContain(invitation);
      expect(
        await api.database.db
          .select()
          .from(gameSlots)
          .where(eq(gameSlots.gameId, room.snapshot.gameId)),
      ).toHaveLength(1);
      expect(
        await api.database.db
          .select()
          .from(roomHistoryAccess)
          .where(eq(roomHistoryAccess.gameId, room.snapshot.gameId)),
      ).toHaveLength(1);
      expect(
        await api.repository.write((tx) => tx.getAiController(room.snapshot.gameId)),
      ).toBeUndefined();
      const saved = await api.repository.read((reader) =>
        reader.getRoomCreationOperation(owner.principal.userId),
      );
      expect(saved).toMatchObject({
        operationId: operation.operationId,
        state: "consumed",
        ownerColor,
        gameId: room.snapshot.gameId,
      });
      expect(saved!.expiresAt.getTime() - saved!.issuedAt.getTime()).toBe(600_000);
      const secondApi = await harness.createAuthenticatedApi();
      const retry = await harness.post(secondApi, owner.cookie, "/rooms", payload);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual({ room, invitation: null });
      const changed = await harness.post(api, owner.cookie, "/rooms", {
        ...payload,
        ownerColor: ownerColor === "white" ? "black" : "white",
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: "ROOM_OPERATION_CONFLICT" });
      expect(changed.json()).not.toHaveProperty("currentSnapshot");
      const outsider = await harness.guest(api);
      const denied = await api.app.inject({
        url: `/rooms/${room.snapshot.gameId}`,
        headers: { cookie: outsider.cookie },
      });
      expect(denied.statusCode).toBe(404);
      const read = await harness.view(api, owner.cookie, room.snapshot.gameId);
      for (const secret of [
        invitation,
        stored!.invitationDigest!,
        owner.principal.userId,
        owner.principal.sessionId,
      ]) {
        expect(JSON.stringify(read)).not.toContain(secret);
      }
    },
  );

  it("requires a verified, profile-complete account and never bootstraps a guest implicitly", async () => {
    const api = await harness.createAuthenticatedApi();
    const guest = await harness.guest(api);
    const incomplete = await harness.account(api, false);
    const unverified = await harness.account(api);
    await api.database.db
      .update(authUsers)
      .set({ emailVerified: false })
      .where(eq(authUsers.id, unverified.principal.userId));
    for (const [cookie, status] of [
      ["", 401],
      [guest.cookie, 401],
      [incomplete.cookie, 403],
      [unverified.cookie, 403],
    ] as const) {
      const response = await harness.post(api, cookie, "/rooms/creation-operation", {});
      expect(response.statusCode, response.body).toBe(status);
      expect(response.headers["set-cookie"]).toBeUndefined();
      const create = await harness.post(api, cookie, "/rooms", {
        operationId: randomUUID(),
        ownerColor: "white",
      });
      expect(create.statusCode).toBe(status);
    }
    const join = await harness.post(api, "", "/rooms/join", {
      commandId: randomUUID(),
      invitation: randomBytes(32).toString("base64url"),
    });
    expect(join.statusCode).toBe(401);
    expect(join.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects unknown, replaced, expired and foreign operations without creating a game", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const first = await harness.operation(api, owner.cookie);
    const second = await harness.operation(api, owner.cookie);
    for (const [cookie, operationId] of [
      [owner.cookie, randomUUID()],
      [owner.cookie, first.operationId],
      [other.cookie, second.operationId],
    ]) {
      const response = await harness.post(api, cookie!, "/rooms", {
        operationId,
        ownerColor: "white",
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "ROOM_OPERATION_UNAVAILABLE" });
    }
    await api.database.db
      .update(roomCreationOperations)
      .set({ issuedAt: new Date(0), expiresAt: new Date(600_000) })
      .where(eq(roomCreationOperations.userId, owner.principal.userId));
    const expired = await harness.post(api, owner.cookie, "/rooms", {
      operationId: second.operationId,
      ownerColor: "white",
    });
    expect(expired.json()).toMatchObject({ code: "ROOM_OPERATION_UNAVAILABLE" });
    expect(
      await api.repository.read((reader) =>
        reader.findUnfinishedAccountGame(owner.principal.userId),
      ),
    ).toBeUndefined();
    expect(
      await api.database.db
        .select()
        .from(roomCreationOperations)
        .where(eq(roomCreationOperations.userId, owner.principal.userId)),
    ).toHaveLength(1);
  });

  it("does not recreate a room when a lost creation response is retried after closure and physical cleanup", async () => {
    const { api, owner, room, payload } = await harness.room();
    const gameId = room.snapshot.gameId;
    const close = await harness.post(api, owner.cookie, `/games/${gameId}/lifecycle`, {
      gameId,
      action: "abort",
      expectedVersion: 0,
      commandId: randomUUID(),
    });
    expect(close.statusCode, close.body).toBe(200);
    expect((await harness.post(api, owner.cookie, "/rooms", payload)).json()).toMatchObject({
      room: { snapshot: { state: "aborted" } },
      invitation: null,
    });
    expect(
      (await harness.post(api, owner.cookie, `/games/${gameId}/delete`, { gameId, confirm: true }))
        .statusCode,
    ).toBe(200);
    expect(await api.repository.read((reader) => reader.getGame(gameId))).toBeUndefined();
    const retry = await harness.post(api, owner.cookie, "/rooms", payload);
    expect(retry.json()).toMatchObject({ code: "ROOM_OPERATION_UNAVAILABLE" });
    const next = await harness.operation(api, owner.cookie);
    const fresh = await harness.post(api, owner.cookie, "/rooms", {
      ...payload,
      operationId: next.operationId,
    });
    expect(fresh.statusCode).toBe(200);
    expect(roomIssuedResponseSchema.parse(fresh.json()).room.snapshot.gameId).not.toBe(gameId);
    expect(
      (await harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true }))
        .statusCode,
    ).toBe(200);
    expect(
      await api.repository.read((reader) =>
        reader.getRoomCreationOperation(owner.principal.userId),
      ),
    ).toBeUndefined();
    expect((await harness.post(api, owner.cookie, "/rooms", payload)).statusCode).toBe(401);
  });

  it("resolves only bounded availability before authentication and enforces Origin, strict bodies and a rate limit", async () => {
    const { api, invitation } = await harness.room();
    for (const [value, status] of [
      [invitation, "joinable"],
      [randomBytes(32).toString("base64url"), "unavailable"],
    ]) {
      const response = await harness.post(api, "", "/rooms/invitations/resolve", {
        invitation: value,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const payload of [{ invitation, gameId: randomUUID() }, { invitation: "bad" }]) {
      const invalid = await harness.post(api, "", "/rooms/invitations/resolve", payload);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain(invitation);
    }
    const wrongOrigin = await api.app.inject({
      method: "POST",
      url: "/rooms/invitations/resolve",
      payload: { invitation },
      headers: { origin: "https://outsider.example" },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const query = await harness.post(api, "", `/rooms/invitations/resolve?invite=${invitation}`, {
      invitation,
    });
    expect(query.statusCode).toBe(400);
    let limited = false;
    for (let index = 0; index < 40; index++) {
      const response = await api.app.inject({
        method: "POST",
        url: "/rooms/invitations/resolve",
        payload: { invitation },
        headers: { origin: WEB_ORIGIN },
        remoteAddress: "192.0.2.222",
      });
      if (response.statusCode === 429) {
        limited = true;
        expect(response.body).not.toContain(invitation);
        break;
      }
      expect(response.statusCode).toBe(200);
    }
    expect(limited).toBe(true);
  });

  it.each(["account", "guest"] as const)(
    "atomically joins a %s opposite a Black owner and recovers only its accepted admission",
    async (kind) => {
      const { api, owner, room, invitation } = await harness.room("black");
      const opponent = kind === "account" ? await harness.account(api) : await harness.guest(api);
      const outsider = await harness.guest(api);
      const gameId = room.snapshot.gameId;
      const self = await harness.post(api, owner.cookie, "/rooms/join", {
        invitation,
        commandId: randomUUID(),
      });
      expect(self.json()).toMatchObject({ code: "ROOM_SELF_JOIN" });
      const commandId = randomUUID();
      const joined = await harness.join(api, opponent.cookie, invitation, commandId);
      expect(joined).toMatchObject({
        state: "joined",
        invitationAvailable: false,
        viewer: { color: "white", isOwner: false },
        capabilities: {
          canMove: true,
          canResign: true,
          canClose: false,
          canManageInvitation: false,
        },
        snapshot: { state: "active", version: 1, turn: "white", moves: [] },
      });
      expect(joined.players.white.kind).toBe(kind);
      expect(
        await api.database.db.select().from(gameSlots).where(eq(gameSlots.gameId, gameId)),
      ).toHaveLength(2);
      const restarted = await harness.createAuthenticatedApi();
      expect(await harness.join(restarted, opponent.cookie, invitation, commandId)).toEqual(joined);
      for (const [cookie, id] of [
        [outsider.cookie, commandId],
        [opponent.cookie, randomUUID()],
      ]) {
        const denied = await harness.post(api, cookie!, "/rooms/join", {
          invitation,
          commandId: id,
        });
        expect(denied.json()).toMatchObject({ code: "ROOM_UNAVAILABLE" });
        expect(denied.json()).not.toHaveProperty("snapshot");
      }
      expect(
        (await harness.post(api, "", "/rooms/invitations/resolve", { invitation })).json(),
      ).toEqual({ status: "unavailable" });
      const move = await harness.post(
        api,
        opponent.cookie,
        `/games/${gameId}/moves`,
        command(joined.snapshot, "e2e4"),
      );
      expect(move.statusCode, move.body).toBe(200);
      expect(
        (await harness.join(restarted, opponent.cookie, invitation, commandId)).snapshot.version,
      ).toBe(2);
      expect(
        (
          await api.app.inject({ url: "/games/unfinished", headers: { cookie: opponent.cookie } })
        ).json(),
      ).toMatchObject({ game: { snapshot: { gameId } } });
      const close = await harness.post(api, owner.cookie, `/games/${gameId}/lifecycle`, {
        gameId,
        action: "abort",
        expectedVersion: 2,
        commandId: randomUUID(),
      });
      expect(close.statusCode).toBe(200);
      if (kind === "account") {
        expect(
          (
            await harness.post(api, opponent.cookie, `/games/${gameId}/delete`, {
              gameId,
              confirm: true,
            })
          ).statusCode,
        ).toBe(200);
        const removed = await harness.post(api, opponent.cookie, "/rooms/join", {
          invitation,
          commandId,
        });
        expect(removed.statusCode).toBe(404);
        expect(removed.json()).not.toHaveProperty("snapshot");
      }
    },
  );

  it("replaces and revokes invitations only for a waiting owner, fencing repeated and stale actions", async () => {
    const { api, owner, room, invitation } = await harness.room();
    const guest = await harness.guest(api);
    const gameId = room.snapshot.gameId;
    const payload = { gameId, action: "replace", expectedVersion: 0, commandId: randomUUID() };
    expect(
      (await harness.post(api, guest.cookie, `/rooms/${gameId}/invitation`, payload)).statusCode,
    ).toBe(404);
    const replaced = await harness.post(api, owner.cookie, `/rooms/${gameId}/invitation`, payload);
    expect(replaced.statusCode, replaced.body).toBe(200);
    const next = replaced.json<{ invitation: string; room: { snapshot: { version: number } } }>();
    expect(next.invitation).not.toBe(invitation);
    expect(next.room.snapshot.version).toBe(1);
    const retry = await harness.post(api, owner.cookie, `/rooms/${gameId}/invitation`, payload);
    expect(retry.statusCode).toBe(409);
    expect(retry.body).not.toContain(next.invitation);
    expect(
      (
        await harness.post(api, guest.cookie, "/rooms/join", {
          invitation,
          commandId: randomUUID(),
        })
      ).json(),
    ).toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect(
      (
        await harness.post(api, owner.cookie, `/rooms/${gameId}/invitation`, {
          ...payload,
          action: "revoke",
          expectedVersion: 1,
          commandId: randomUUID(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await harness.post(api, "", "/rooms/invitations/resolve", { invitation: next.invitation })
      ).json(),
    ).toEqual({ status: "unavailable" });
    expect((await harness.view(api, owner.cookie, gameId)).snapshot.state).toBe("paused");
    expect(
      await api.database.db.select().from(gameSlots).where(eq(gameSlots.gameId, gameId)),
    ).toHaveLength(1);
    const close = await harness.post(api, owner.cookie, `/games/${gameId}/lifecycle`, {
      gameId,
      action: "abort",
      expectedVersion: 2,
      commandId: randomUUID(),
    });
    expect(close.statusCode).toBe(200);
    expect(
      (
        await harness.post(api, owner.cookie, `/rooms/${gameId}/invitation`, {
          ...payload,
          expectedVersion: 3,
          commandId: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
  });

  it("gives a valid account precedence over its guest cookie and fences expired or mismatched identities", async () => {
    const { api, owner, room, invitation } = await harness.room();
    const guest = await harness.guest(api);
    const account = await harness.account(api);
    const commandId = randomUUID();
    const self = await harness.post(api, `${owner.cookie}; ${guest.cookie}`, "/rooms/join", {
      invitation,
      commandId,
    });
    expect(self.json()).toMatchObject({ code: "ROOM_SELF_JOIN" });
    const joined = await harness.join(
      api,
      `${account.cookie}; ${guest.cookie}`,
      invitation,
      commandId,
    );
    expect(joined.players.black.kind).toBe("account");
    const guestRead = await api.app.inject({
      url: `/rooms/${room.snapshot.gameId}`,
      headers: { cookie: guest.cookie },
    });
    expect(guestRead.statusCode).toBe(404);
    const mismatch = await api.app.inject({
      url: `/rooms/${room.snapshot.gameId}`,
      headers: { cookie: account.cookie, "x-neurochess-expected-account": owner.principal.userId },
    });
    expect(mismatch.statusCode).toBe(401);
    await api.database.db
      .delete(authSessions)
      .where(eq(authSessions.id, account.principal.sessionId));
    const expired = await harness.post(api, `${account.cookie}; ${guest.cookie}`, "/rooms/join", {
      invitation,
      commandId,
    });
    expect(expired.statusCode).toBe(401);
    expect(
      await api.database.db
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, room.snapshot.gameId)),
    ).toHaveLength(2);
    expect(
      await api.database.db.select().from(games).where(eq(games.id, room.snapshot.gameId)),
    ).toHaveLength(1);
  });
});
