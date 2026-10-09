import { randomUUID } from "node:crypto";

import { roomIssuedResponseSchema } from "@neurochess/contracts";
import { authSessions, authUsers, guestSessions } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAccountAuth } from "../src/auth/service.js";

import { authEnvironment } from "./account-game-helpers.js";
import { createTestMailbox } from "./auth-mailbox.js";
import { RoomSocketHarness } from "./room-socket-helpers.js";

const harness = new RoomSocketHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

describe("idle room session fences", () => {
  it.each(["sign_out", "session_expiry", "guest_expiry"] as const)(
    "fences %s without a game event and refuses the old authority on reconnect",
    async (kind) => {
      const { api, owner, room, invitation } = await harness.room("white", {
        roomRealtimeLimits: { reconciliationMs: 100 },
      });
      const player =
        kind === "guest_expiry" ? await harness.guest(api) : await harness.account(api);
      await harness.join(api, player.cookie, invitation, randomUUID());
      const client = await harness.connect(api, player.cookie);
      client.subscribe(
        room.snapshot.gameId,
        player.principal.kind === "guest" ? "guest" : player.principal.userId,
      );
      await client.next("snapshot");
      if (player.principal.kind === "guest") {
        await api.database.db
          .update(guestSessions)
          .set({
            createdAt: sql`clock_timestamp() - interval '3 seconds'`,
            lastSeenAt: sql`clock_timestamp() - interval '2 seconds'`,
            expiresAt: sql`clock_timestamp() - interval '1 second'`,
          })
          .where(eq(guestSessions.id, player.principal.guestSessionId));
      } else if (kind === "session_expiry") {
        await api.database.db
          .update(authSessions)
          .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(authSessions.id, player.principal.sessionId));
      } else {
        expect((await harness.post(api, player.cookie, "/api/auth/sign-out", {})).statusCode).toBe(
          200,
        );
      }
      expect(await client.next("access_lost")).toEqual({ protocol: 1, type: "access_lost" });
      expect(await client.closed).toBe(1008);
      expect(client.messages.at(-1)?.type).toBe("access_lost");
      expect(await harness.rejectedUpgrade(api, player.cookie)).toBe(401);
      expect((await harness.view(api, owner.cookie, room.snapshot.gameId)).snapshot).toMatchObject({
        state: "active",
        version: 1,
      });
    },
  );

  it("fences only the revoked session while another tab of that participant stays online", async () => {
    const { api, owner, room, invitation } = await harness.room("white", {
      roomRealtimeLimits: { reconciliationMs: 100 },
    });
    const guest = await harness.guest(api);
    await harness.join(api, guest.cookie, invitation, randomUUID());
    const otherSession = await owner.anotherSession();
    const first = await harness.connect(api, owner.cookie);
    const second = await harness.connect(api, otherSession.cookie);
    const observer = await harness.connect(api, guest.cookie);
    for (const client of [first, second, observer]) {
      client.subscribe(
        room.snapshot.gameId,
        client === observer ? "guest" : owner.principal.userId,
      );
      await client.next("snapshot");
    }
    await expect
      .poll(() => observer.messages.filter((message) => message.type === "presence").at(-1))
      .toMatchObject({ online: { white: true, black: true } });
    expect((await harness.post(api, owner.cookie, "/api/auth/sign-out", {})).statusCode).toBe(200);
    await first.next("access_lost");
    await first.closed;
    await second.next("revision");
    expect(second.socket.readyState).toBe(second.socket.OPEN);
    expect(
      observer.messages
        .filter((message) => message.type === "presence")
        .every((message) => message.online.white),
    ).toBe(true);
    const returning = await harness.connect(api, otherSession.cookie);
    returning.subscribe(room.snapshot.gameId, owner.principal.userId);
    expect((await returning.next("snapshot")).room.viewer).toEqual({
      color: "white",
      isOwner: true,
    });
  });

  it("fences idle sockets after a real password reset even when another session used the room", async () => {
    const mailbox = createTestMailbox();
    const api = await harness.createApi({
      auth: (database, events) => createAccountAuth(database, authEnvironment, mailbox, events),
      roomRealtimeLimits: { reconciliationMs: 100 },
    });
    const owner = await harness.account(api);
    const operation = await harness.operation(api, owner.cookie);
    const created = await harness.post(api, owner.cookie, "/rooms", {
      operationId: operation.operationId,
      ownerColor: "white",
    });
    const { room } = roomIssuedResponseSchema.parse(created.json());
    const second = await owner.anotherSession();
    const clients = await Promise.all([
      harness.connect(api, owner.cookie),
      harness.connect(api, second.cookie),
    ]);
    for (const client of clients) {
      client.subscribe(room.snapshot.gameId, owner.principal.userId);
      await client.next("snapshot");
    }
    const [user] = await api.database.db
      .select({ email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, owner.principal.userId));
    expect(
      (await harness.post(api, "", "/api/auth/request-password-reset", { email: user!.email }))
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
    for (const client of clients) {
      await client.next("access_lost");
      expect(await client.closed).toBe(1008);
      expect(client.messages.at(-1)?.type).toBe("access_lost");
    }
    expect(await harness.rejectedUpgrade(api, owner.cookie)).toBe(401);
    expect(await harness.rejectedUpgrade(api, second.cookie)).toBe(401);
  });

  it.each(["account_delete", "history_delete", "history_clear"] as const)(
    "reconciles %s with a lost invalidation and cannot restore removed access",
    async (kind) => {
      const { api, owner, room, invitation } = await harness.room("white", {
        roomRealtimeLimits: { reconciliationMs: 100 },
      });
      const opponent = await harness.account(api);
      await harness.join(api, opponent.cookie, invitation, randomUUID());
      if (kind !== "account_delete") {
        expect(
          (
            await harness.post(api, owner.cookie, `/games/${room.snapshot.gameId}/lifecycle`, {
              gameId: room.snapshot.gameId,
              expectedVersion: 1,
              commandId: randomUUID(),
              action: "abort",
            })
          ).statusCode,
        ).toBe(200);
      }
      const removed = await harness.connect(api, owner.cookie);
      const retained = await harness.connect(api, opponent.cookie);
      removed.subscribe(room.snapshot.gameId, owner.principal.userId);
      retained.subscribe(room.snapshot.gameId, opponent.principal.userId);
      await removed.next("snapshot");
      await retained.next("snapshot");
      await removed.next("revision");
      await retained.next("revision");
      vi.spyOn(api.roomEvents, "publish").mockImplementation(() => undefined);
      const endpoint =
        kind === "account_delete"
          ? "/api/auth/delete-account"
          : kind === "history_clear"
            ? "/games/history/clear"
            : `/games/${room.snapshot.gameId}/delete`;
      expect(
        (
          await harness.post(
            api,
            owner.cookie,
            endpoint,
            kind === "history_delete"
              ? { gameId: room.snapshot.gameId, confirm: true }
              : { confirm: true },
          )
        ).statusCode,
      ).toBe(200);
      await removed.next("access_lost");
      expect(await removed.closed).toBe(1008);
      if (kind === "account_delete") {
        await expect
          .poll(() => retained.messages.filter((message) => "room" in message).at(-1))
          .toMatchObject({
            room: {
              snapshot: { state: "aborted", version: 2 },
              players: { white: { kind: "deleted" } },
            },
          });
        expect(await harness.rejectedUpgrade(api, owner.cookie)).toBe(401);
      } else {
        const returned = await harness.connect(api, owner.cookie);
        returned.subscribe(room.snapshot.gameId, owner.principal.userId);
        await returned.next("access_lost");
        expect(
          returned.messages.some((message) => "room" in message || message.type === "presence"),
        ).toBe(false);
      }
      const surviving = await harness.view(api, opponent.cookie, room.snapshot.gameId);
      expect(surviving.snapshot.state).toBe("aborted");
      expect(
        (
          await harness.post(api, opponent.cookie, "/rooms/join", {
            invitation,
            commandId: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
    },
  );

  it("does not transfer an expired guest's seat to a fresh guest identity", async () => {
    const { api, owner, room, invitation } = await harness.room("white", {
      roomRealtimeLimits: { reconciliationMs: 100 },
    });
    const guest = await harness.guest(api);
    const joinId = randomUUID();
    await harness.join(api, guest.cookie, invitation, joinId);
    await api.database.db
      .update(guestSessions)
      .set({
        createdAt: sql`clock_timestamp() - interval '3 seconds'`,
        lastSeenAt: sql`clock_timestamp() - interval '2 seconds'`,
        expiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(guestSessions.id, guest.id));
    const replacement = await harness.guest(api, guest.cookie);
    expect(replacement.id).not.toBe(guest.id);
    const returned = await harness.connect(api, replacement.cookie);
    returned.subscribe(room.snapshot.gameId, "guest");
    await returned.next("access_lost");
    expect(returned.messages).toEqual([{ protocol: 1, type: "access_lost" }]);
    expect(
      (
        await harness.post(api, replacement.cookie, "/rooms/join", {
          invitation,
          commandId: joinId,
        })
      ).statusCode,
    ).toBe(409);
    expect((await harness.view(api, owner.cookie, room.snapshot.gameId)).snapshot.state).toBe(
      "active",
    );
  });
});
