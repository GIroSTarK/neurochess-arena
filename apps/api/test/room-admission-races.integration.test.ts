import { randomUUID } from "node:crypto";

import { roomIssuedResponseSchema } from "@neurochess/contracts";
import {
  authSessions,
  gameParticipants,
  games,
  gameSlots,
  roomHistoryAccess,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createRoomService } from "../src/rooms/service.js";

import { aiMatch, humanMatch } from "./ai-turn-helpers.js";
import type { TestApi } from "./helpers.js";
import { RoomApiHarness } from "./room-api-helpers.js";

const harness = new RoomApiHarness();
afterEach(() => harness.dispose());

async function blocked(api: TestApi, pid: number, count = 1) {
  await expect
    .poll(
      async () =>
        (
          await api.database.db.execute<{ count: number }>(sql`
      with recursive blocked(pid) as (
        select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        union select a.pid from pg_stat_activity a join blocked b on b.pid = any(pg_blocking_pids(a.pid))
      ) select count(*)::int as count from blocked
    `)
        ).rows[0]?.count,
    )
    .toBe(count);
}

describe("private room admission transactions", () => {
  it("consumes one creation operation once across independent API connections", async () => {
    const api = await harness.createAuthenticatedApi();
    const second = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const operation = await harness.operation(api, owner.cookie);
    const payload = { operationId: operation.operationId, ownerColor: "black" };
    const responses = await Promise.all(
      [api, second].map((instance) => harness.post(instance, owner.cookie, "/rooms", payload)),
    );
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    const results = responses.map((response) => roomIssuedResponseSchema.parse(response.json()));
    expect(results[0]!.room).toEqual(results[1]!.room);
    expect(results.filter((result) => result.invitation !== null)).toHaveLength(1);
    expect(
      await api.database.db
        .select()
        .from(games)
        .where(eq(games.ownerUserId, owner.principal.userId)),
    ).toHaveLength(1);
  });

  it("admits exactly one of two competing joiners with no losing seat, slot or access", async () => {
    const { api, invitation, room } = await harness.room();
    const second = await harness.createAuthenticatedApi();
    const opponents = await Promise.all([harness.account(api), harness.account(second)]);
    const responses = await Promise.all(
      opponents.map((opponent, index) =>
        harness.post(index ? second : api, opponent.cookie, "/rooms/join", {
          invitation,
          commandId: randomUUID(),
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const loser = opponents[responses.findIndex((response) => response.statusCode === 409)]!;
    expect(responses.find((response) => response.statusCode === 409)!.json()).toMatchObject({
      code: "ROOM_UNAVAILABLE",
    });
    expect(
      await api.repository.read((reader) =>
        reader.findUnfinishedAccountGame(loser.principal.userId),
      ),
    ).toBeUndefined();
    const gameId = room.snapshot.gameId;
    expect(
      await api.database.db.select().from(gameSlots).where(eq(gameSlots.gameId, gameId)),
    ).toHaveLength(2);
    expect(
      await api.database.db
        .select()
        .from(roomHistoryAccess)
        .where(eq(roomHistoryAccess.gameId, gameId)),
    ).toHaveLength(2);
    const seats = await api.repository.read((reader) => reader.getParticipants(gameId));
    expect(seats.every((seat) => seat.userId !== loser.principal.userId)).toBe(true);
    expect(
      (await api.repository.read((reader) => reader.getRoom(gameId)))?.invitationDigest,
    ).toBeNull();
  });

  it.each([
    { kind: "account", configuration: aiMatch },
    { kind: "guest", configuration: aiMatch },
    { kind: "account", configuration: humanMatch },
    { kind: "guest", configuration: humanMatch },
  ] as const)(
    "arbitrates $configuration.mode creation versus $kind room joining at the public slot",
    async ({ kind, configuration }) => {
      const { api, invitation, room } = await harness.room();
      const second = await harness.createAuthenticatedApi();
      const opponent = kind === "account" ? await harness.account(api) : await harness.guest(api);
      const [join, ai] = await Promise.all([
        harness.post(api, opponent.cookie, "/rooms/join", { invitation, commandId: randomUUID() }),
        harness.post(second, opponent.cookie, "/games", configuration),
      ]);
      expect([join.statusCode, ai.statusCode].sort()).toEqual(
        join.statusCode === 200 ? [200, 409] : [201, 409],
      );
      const conflict = join.statusCode === 409 ? join : ai;
      expect(conflict.json()).toMatchObject({ code: "GAME_CONFLICT" });
      const stored = await api.repository.read((reader) => reader.getGame(room.snapshot.gameId));
      const seats = await api.repository.read((reader) =>
        reader.getParticipants(room.snapshot.gameId),
      );
      expect(stored?.state).toBe(join.statusCode === 200 ? "active" : "paused");
      expect(
        seats.filter((seat) => seat.userId !== null || seat.guestSessionId !== null),
      ).toHaveLength(join.statusCode === 200 ? 2 : 1);
      if (kind === "guest") {
        expect((await harness.post(api, opponent.cookie, "/sandbox/games", {})).statusCode).toBe(
          201,
        );
      }
    },
  );

  it("rolls back admission, receipt, access and slot after a real seat insert fails later", async () => {
    const { api, invitation, room } = await harness.room();
    const opponent = await harness.account(api);
    const failed = await harness.createAuthenticatedApi({
      repository: (repository) => ({
        ...repository,
        write: (action) =>
          repository.write((tx) =>
            action({
              ...tx,
              async updatePosition() {
                throw new Error("fixture commit failure");
              },
            }),
          ),
      }),
    });
    const commandId = randomUUID();
    const response = await harness.post(failed, opponent.cookie, "/rooms/join", {
      invitation,
      commandId,
    });
    expect(response.statusCode).toBe(500);
    const gameId = room.snapshot.gameId;
    expect(await api.repository.read((reader) => reader.getGame(gameId))).toMatchObject({
      state: "paused",
      version: 0,
    });
    expect(await api.repository.read((reader) => reader.getRoom(gameId))).toMatchObject({
      state: "waiting",
      joinCommandId: null,
      joinedInvitationDigest: null,
    });
    expect(
      await api.database.db.select().from(gameSlots).where(eq(gameSlots.gameId, gameId)),
    ).toHaveLength(1);
    expect(
      await api.database.db
        .select()
        .from(roomHistoryAccess)
        .where(eq(roomHistoryAccess.gameId, gameId)),
    ).toHaveLength(1);
    expect(
      await api.database.db
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.userId, opponent.principal.userId)),
    ).toHaveLength(0);
    expect((await harness.join(api, opponent.cookie, invitation, commandId)).snapshot.state).toBe(
      "active",
    );
  });

  it("rolls back creation and consumption if room insertion fails, leaving the same operation retryable", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const operation = await harness.operation(api, owner.cookie);
    const failed = await harness.createAuthenticatedApi({
      repository: (repository) => ({
        ...repository,
        write: (action) =>
          repository.write((tx) =>
            action({
              ...tx,
              async insertRoom(input) {
                await tx.insertRoom(input);
                throw new Error("fixture failure after insert");
              },
            }),
          ),
      }),
    });
    const payload = { operationId: operation.operationId, ownerColor: "white" };
    expect((await harness.post(failed, owner.cookie, "/rooms", payload)).statusCode).toBe(500);
    expect(
      await api.repository.read((reader) =>
        reader.findUnfinishedAccountGame(owner.principal.userId),
      ),
    ).toBeUndefined();
    expect(
      await api.repository.read((reader) =>
        reader.getRoomCreationOperation(owner.principal.userId),
      ),
    ).toMatchObject({ state: "pending", gameId: null });
    expect((await harness.post(api, owner.cookie, "/rooms", payload)).statusCode).toBe(200);
  });

  it("fences public joining after owner deletion without leaving seats, slots, access or a private snapshot", async () => {
    const { api, owner, invitation, room } = await harness.room();
    const second = await harness.createAuthenticatedApi();
    const opponent = await harness.account(second);
    const gameId = room.snapshot.gameId;
    let deleting: ReturnType<typeof harness.post> | undefined;
    let joining: ReturnType<typeof harness.post> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx.select().from(games).where(eq(games.id, gameId)).for("update");
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
      deleting = harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true });
      await blocked(api, pid);
      joining = harness.post(second, opponent.cookie, "/rooms/join", {
        invitation,
        commandId: randomUUID(),
      });
      await blocked(api, pid, 2);
    });
    expect((await deleting)?.statusCode).toBe(200);
    expect((await joining)?.statusCode).toBe(409);
    expect((await joining)?.json()).toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect((await joining)?.json()).not.toHaveProperty("currentSnapshot");
    expect((await joining)?.json()).not.toHaveProperty("snapshot");
    expect(await api.repository.read((reader) => reader.getGame(gameId))).toBeUndefined();
    expect(await api.repository.read((reader) => reader.getRoom(gameId))).toBeUndefined();
    expect(await api.repository.read((reader) => reader.getParticipants(gameId))).toEqual([]);
    expect(await api.database.db.$count(gameSlots, eq(gameSlots.gameId, gameId))).toBe(0);
    expect(
      await api.database.db.$count(roomHistoryAccess, eq(roomHistoryAccess.gameId, gameId)),
    ).toBe(0);
    expect(
      await api.database.db.$count(
        gameParticipants,
        eq(gameParticipants.userId, owner.principal.userId),
      ),
    ).toBe(0);
    expect(
      await second.repository.read((reader) =>
        reader.findUnfinishedAccountGame(opponent.principal.userId),
      ),
    ).toBeUndefined();
    for (const url of [`/rooms/${gameId}`, `/games/${gameId}`]) {
      const response = await second.app.inject({ url, headers: { cookie: opponent.cookie } });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).not.toHaveProperty("currentSnapshot");
      expect(response.json()).not.toHaveProperty("snapshot");
    }
  });

  it.each(["owner", "opponent"] as const)(
    "serializes public joining against deletion of the $0 account",
    async (deleted) => {
      const { api, owner, invitation, room } = await harness.room();
      const second = await harness.createAuthenticatedApi();
      const opponent = await harness.account(api);
      const deleting = deleted === "owner" ? owner : opponent;
      const [join, removal] = await Promise.all([
        harness.post(api, opponent.cookie, "/rooms/join", { invitation, commandId: randomUUID() }),
        harness.post(second, deleting.cookie, "/api/auth/delete-account", { confirm: true }),
      ]);
      expect(removal.statusCode, removal.body).toBe(200);
      expect([200, 401, 409]).toContain(join.statusCode);
      const stored = await api.repository.read((reader) => reader.getGame(room.snapshot.gameId));
      expect(stored?.state).not.toBe("active");
      expect(
        await api.database.db
          .select()
          .from(gameSlots)
          .where(eq(gameSlots.userId, deleting.principal.userId)),
      ).toEqual([]);
      expect(
        await api.database.db
          .select()
          .from(gameParticipants)
          .where(eq(gameParticipants.userId, deleting.principal.userId)),
      ).toEqual([]);
      if (join.statusCode === 200) {
        expect(stored?.state).toBe("aborted");
        expect(
          await api.database.db
            .select()
            .from(gameSlots)
            .where(eq(gameSlots.gameId, room.snapshot.gameId)),
        ).toEqual([]);
      }
    },
  );

  it("rechecks the exact session after waiting for the room gate", async () => {
    const { api, invitation, room } = await harness.room();
    const opponent = await harness.account(api);
    let entered!: () => void;
    let release!: () => void;
    const gateEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gateReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocker = 0;
    const locked = api.repository.write(async (tx) => {
      await tx.lockSharedRooms();
      entered();
      await gateReleased;
    });
    await gateEntered;
    const service = createRoomService(api.repository);
    const pending = service.join(opponent.principal, { invitation, commandId: randomUUID() });
    const observed = pending.then(
      () => "accepted",
      (error: unknown) => error,
    );
    try {
      await expect
        .poll(async () => {
          const result = await api.database.db.execute<{ count: number }>(
            sql`select count(*)::int as count from pg_stat_activity where wait_event = 'advisory' and datname = current_database()`,
          );
          blocker = result.rows[0]?.count ?? 0;
          return blocker;
        })
        .toBeGreaterThan(0);
      await api.database.db
        .delete(authSessions)
        .where(eq(authSessions.id, opponent.principal.sessionId));
    } finally {
      release();
    }
    await locked;
    expect(await observed).toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      await api.repository.read((reader) => reader.getGame(room.snapshot.gameId)),
    ).toMatchObject({ state: "paused", version: 0 });
  });
});
