import { randomUUID } from "node:crypto";

import { gameErrorResponseSchema, gameSnapshotSchema } from "@neurochess/contracts";
import { gameCommands, gameParticipants, games, guestSessions, moves } from "@neurochess/database";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GUEST_COOKIE_NAME } from "../src/guests/service.js";
import { createLoggerOptions } from "../src/logger.js";

import {
  ApiHarness,
  command,
  createSandbox,
  FOOLS_MATE,
  KNIGHT_CYCLE,
  play,
  snapshot,
  submit,
  type TestApi,
  WEB_ORIGIN,
} from "./helpers.js";

let harness: ApiHarness;
let api: TestApi;

beforeEach(async () => {
  harness = new ApiHarness();
  api = await harness.createApi();
});
afterEach(async () => {
  await harness.dispose();
});

describe("guest HTTP boundary", () => {
  it("accepts cookie-owned moves over a real HTTP listener", async () => {
    const address = await api.app.listen({ host: "127.0.0.1", port: 0 });
    const headers = { origin: WEB_ORIGIN, "content-type": "application/json" };
    const bootstrapped = await fetch(`${address}/guest-session`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(bootstrapped.status).toBe(200);
    expect(await bootstrapped.json()).toEqual({ status: "ready" });
    const cookie = bootstrapped.headers.getSetCookie()[0]?.split(";")[0];
    expect(cookie).toBeDefined();
    // Register the already-created identity for narrowly scoped fixture cleanup.
    const guest = await harness.guest(api, cookie);
    const created = await fetch(`${address}/sandbox/games`, {
      method: "POST",
      headers: { ...headers, cookie: guest.cookie },
      body: "{}",
    });
    expect(created.status).toBe(201);
    const initial = gameSnapshotSchema.parse(await created.json());
    const accepted = await fetch(`${address}/games/${initial.gameId}/moves`, {
      method: "POST",
      headers: { ...headers, cookie: guest.cookie },
      body: JSON.stringify(command(initial, "e2e4")),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(gameSnapshotSchema.parse(await accepted.json())).toEqual(
      await snapshot(api, guest, initial.gameId),
    );
  });

  it("uses an opaque, hashed, reusable secure cookie and renews inactivity expiry", async () => {
    const guest = await harness.guest(api);
    const [before] = await api.database.db
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, guest.id));
    expect(before?.tokenHash).not.toBe(guest.token);
    expect(before?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(before!.expiresAt.getTime() - before!.lastSeenAt.getTime()).toBeCloseTo(86_400_000, -2);
    await api.database.db
      .update(guestSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '1 hour'`,
        expiresAt: sql`clock_timestamp() + interval '1 hour'`,
      })
      .where(eq(guestSessions.id, guest.id));
    const repeated = await harness.guest(api, guest.cookie);
    expect(repeated).toEqual(guest);
    const response = await api.app.inject({
      method: "POST",
      url: "/sandbox/games",
      payload: {},
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const cookie = String(response.headers["set-cookie"]);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=86400"]) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain("Domain=");
    expect(response.body).not.toContain(guest.token);
    expect(response.body).not.toContain(guest.id);
    const [renewed] = await api.database.db
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, guest.id));
    expect(renewed!.expiresAt.getTime()).toBeGreaterThanOrEqual(before!.expiresAt.getTime());
  });

  it("rejects cookie-less concurrent creation and creates no implicit identities", async () => {
    const before = await api.database.db.$count(guestSessions);
    const responses = await Promise.all(
      [1, 2].map(() =>
        api.app.inject({
          method: "POST",
          url: "/sandbox/games",
          payload: {},
          headers: { origin: WEB_ORIGIN },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([401, 401]);
    for (const response of responses) expect(response.headers["set-cookie"]).toBeUndefined();
    expect(await api.database.db.$count(guestSessions)).toBe(before);
  });

  it("rejects malformed, unknown, tampered and expired cookies, without reviving an expired identity", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    for (const token of [
      "invalid",
      "A".repeat(43),
      `${guest.token.startsWith("A") ? "B" : "A"}${guest.token.slice(1)}`,
    ]) {
      const response = await api.app.inject({
        method: "GET",
        url: `/games/${initial.gameId}`,
        headers: { cookie: `${GUEST_COOKIE_NAME}=${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(initial.fen);
    }
    await api.database.db
      .update(guestSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
        expiresAt: sql`clock_timestamp() - interval '1 hour'`,
      })
      .where(eq(guestSessions.id, guest.id));
    expect((await submit(api, guest, command(initial, "e2e4"))).statusCode).toBe(401);
    const fresh = await harness.guest(api, guest.cookie);
    expect(fresh.id).not.toBe(guest.id);
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: `/games/${initial.gameId}`,
          headers: { cookie: fresh.cookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("requires the configured Origin before any POST mutation and supports credentialed preflight", async () => {
    const guest = await harness.guest(api);
    for (const origin of [
      undefined,
      "null",
      "https://untrusted.example",
      "http://127.0.0.1:5173",
    ]) {
      const response = await api.app.inject({
        method: "POST",
        url: "/sandbox/games",
        payload: {},
        headers: { cookie: guest.cookie, ...(origin ? { origin } : {}) },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, guest.id))).toBe(0);
    const response = await api.app.inject({
      method: "OPTIONS",
      url: "/sandbox/games",
      headers: {
        origin: WEB_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("rejects extra fields, arbitrary positions, malformed commands and URL/body mismatches", async () => {
    const guest = await harness.guest(api);
    const headers = { origin: WEB_ORIGIN, cookie: guest.cookie };
    for (const key of [
      "fen",
      "moves",
      "ownerId",
      "guestId",
      "sandbox",
      "isSandbox",
      "mode",
      "result",
    ]) {
      const response = await api.app.inject({
        method: "POST",
        url: "/sandbox/games",
        payload: { [key]: "untrusted" },
        headers,
      });
      expect(response.statusCode).toBe(400);
      expect(gameErrorResponseSchema.parse(response.json()).code).toBe("INVALID_REQUEST");
    }
    const invalidQuery = await api.app.inject({
      method: "POST",
      url: "/sandbox/games?fen=untrusted",
      payload: {},
      headers,
    });
    expect(invalidQuery.statusCode).toBe(400);
    const initial = await createSandbox(api, guest);
    const valid = command(initial, "e2e4");
    for (const payload of [
      { ...valid, sandbox: true },
      { ...valid, expectedVersion: -1 },
      { ...valid, move: "e4" },
      { ...valid, commandId: "invalid" },
      { ...valid, gameId: randomUUID() },
      { ...valid, fen: initial.fen },
    ]) {
      expect(
        (
          await api.app.inject({
            method: "POST",
            url: `/games/${initial.gameId}/moves`,
            payload,
            headers,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: `/games/${initial.gameId}?sandbox=true`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(await snapshot(api, guest, initial.gameId)).toEqual(initial);
  });

  it("does not leak cookies, digests, request bodies or errors into logs or error payloads", async () => {
    const logs: string[] = [];
    const canary = "integration-error-secret-canary";
    const logged = await harness.createApi({
      logger: {
        ...createLoggerOptions("info"),
        stream: {
          write: (chunk: string) => {
            logs.push(chunk);
          },
        },
      },
      repository: (repository) => ({
        ...repository,
        write: async () => {
          throw new Error(canary);
        },
      }),
    });
    const guest = await harness.guest(logged);
    const response = await logged.app.inject({
      method: "POST",
      url: "/sandbox/games",
      payload: {},
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie, authorization: `Bearer ${canary}` },
    });
    expect(response.statusCode).toBe(500);
    expect(gameErrorResponseSchema.parse(response.json()).code).toBe("INTERNAL_SERVER_ERROR");
    for (const value of [canary, guest.token, guest.id]) {
      expect(logs.join("")).not.toContain(value);
      expect(response.body).not.toContain(value);
    }
  });
});

describe("private ownership and sandbox authority", () => {
  it("hides snapshots, moves and conflicts from another guest", async () => {
    const owner = await harness.guest(api);
    const intruder = await harness.guest(api);
    const initial = await createSandbox(api, owner);
    const acceptedCommand = command(initial, "e2e4");
    expect((await submit(api, owner, acceptedCommand)).statusCode).toBe(200);
    const responses = [
      await api.app.inject({
        method: "GET",
        url: `/games/${initial.gameId}`,
        headers: { cookie: intruder.cookie },
      }),
      await submit(api, intruder, acceptedCommand),
      await submit(api, intruder, { ...command(initial, "e7e5"), expectedVersion: 1 }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).not.toHaveProperty("currentSnapshot");
      expect(response.body).not.toContain(initial.fen);
    }
    expect((await snapshot(api, owner, initial.gameId)).moves).toHaveLength(1);
  });

  it.each([
    { name: "disabled in test", options: { sandboxEnabled: false, nodeEnv: "test" as const } },
    {
      name: "disabled in production",
      options: { sandboxEnabled: false, nodeEnv: "production" as const },
    },
    {
      name: "enabled in production",
      options: { sandboxEnabled: true, nodeEnv: "production" as const },
    },
  ])("rejects Sandbox access: $name", async ({ options }) => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const disabled = await harness.createApi(options);
    expect(
      (
        await disabled.app.inject({
          method: "POST",
          url: "/sandbox/games",
          payload: {},
          headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await disabled.app.inject({
          method: "GET",
          url: `/games/${initial.gameId}`,
          headers: { cookie: guest.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect((await submit(disabled, guest, command(initial, "e2e4"))).statusCode).toBe(404);
    expect(await snapshot(api, guest, initial.gameId)).toEqual(initial);
  });

  it("grants ordinary games only explicit seat control, including when sandbox support is enabled", async () => {
    const owner = await harness.guest(api);
    const opponent = await harness.guest(api);
    const initial = await createSandbox(api, owner);
    await api.database.db
      .update(games)
      .set({ isSandbox: false })
      .where(eq(games.id, initial.gameId));
    await api.database.db
      .update(gameParticipants)
      .set({ guestSessionId: opponent.id })
      .where(and(eq(gameParticipants.gameId, initial.gameId), eq(gameParticipants.color, "black")));
    const blackTurn = await play(api, owner, initial, ["e2e4"]);
    expect((await submit(api, owner, command(blackTurn, "e7e5"))).statusCode).toBe(403);
    expect(await snapshot(api, opponent, initial.gameId)).toEqual(blackTurn);
    const whiteTurn = await play(api, opponent, blackTurn, ["e7e5"]);
    expect((await submit(api, opponent, command(whiteTurn, "g1f3"))).statusCode).toBe(403);
    // Retrying White's stale command after the seat changes still yields an authorized conflict.
    const conflict = await submit(api, owner, command(initial, "d2d4"));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toHaveProperty("currentSnapshot", whiteTurn);
  });

  it("keeps sandbox access owner-only even if another guest is assigned a seat", async () => {
    const owner = await harness.guest(api);
    const other = await harness.guest(api);
    const initial = await createSandbox(api, owner);
    await api.database.db
      .update(gameParticipants)
      .set({ guestSessionId: other.id })
      .where(and(eq(gameParticipants.gameId, initial.gameId), eq(gameParticipants.color, "black")));
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: `/games/${initial.gameId}`,
          headers: { cookie: other.cookie },
        })
      ).statusCode,
    ).toBe(404);
    const final = await play(api, owner, initial, ["e2e4", "e7e5"]);
    expect(final.moves).toHaveLength(2);
  });

  it("never turns sandbox authority into authority to submit an AI seat's move", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    await api.database.db
      .update(gameParticipants)
      .set({ seatType: "ai", provider: "openai", modelId: "fixture-model", parameters: {} })
      .where(and(eq(gameParticipants.gameId, initial.gameId), eq(gameParticipants.color, "black")));
    const current = await play(api, guest, initial, ["e2e4"]);
    expect((await submit(api, guest, command(current, "e7e5"))).statusCode).toBe(403);
  });
});

describe("atomic commands and concurrency", () => {
  it("recognizes UUID casing aliases without changing command identity", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const acceptedCommand = command(initial, "e2e4");
    const response = await api.app.inject({
      method: "POST",
      url: `/games/${initial.gameId.toUpperCase()}/moves`,
      payload: { ...acceptedCommand, commandId: acceptedCommand.commandId.toUpperCase() },
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
    });
    expect(response.statusCode).toBe(200);
    const current = gameSnapshotSchema.parse(response.json());
    const retry = await submit(api, guest, {
      ...acceptedCommand,
      expectedVersion: 1,
      move: "e7e5",
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toHaveProperty("currentSnapshot", current);
  });

  it("serializes concurrent creation across independent app instances and database pools", async () => {
    const other = await harness.createApi();
    const guest = await harness.guest(api);
    const responses = await Promise.all(
      [api, other, api, other].map((instance) =>
        instance.app.inject({
          method: "POST",
          url: "/sandbox/games",
          payload: {},
          headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
        }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(3);
    const created = gameSnapshotSchema.parse(
      responses.find((response) => response.statusCode === 201)!.json(),
    );
    for (const conflict of responses.filter((response) => response.statusCode === 409)) {
      expect(conflict.json()).toHaveProperty("currentSnapshot", created);
    }
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, guest.id))).toBe(1);
    expect(
      await api.database.db.$count(gameParticipants, eq(gameParticipants.gameId, created.gameId)),
    ).toBe(2);
  });

  it("counts paused games toward the slot and refuses moves while paused", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    await api.database.db
      .update(games)
      .set({ state: "paused", version: 1 })
      .where(eq(games.id, initial.gameId));
    const paused = await snapshot(api, guest, initial.gameId);
    expect(paused.legalMoves).toEqual([]);
    const response = await api.app.inject({
      method: "POST",
      url: "/sandbox/games",
      payload: {},
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toHaveProperty("currentSnapshot", paused);
    expect((await submit(api, guest, command(paused, "e2e4"))).json()).toHaveProperty(
      "code",
      "INVALID_GAME_STATE",
    );
  });

  it.each(["duplicate", "competing"] as const)(
    "appends exactly one move for concurrent %s commands",
    async (kind) => {
      const other = await harness.createApi();
      const guest = await harness.guest(api);
      const initial = await createSandbox(api, guest);
      const first = command(initial, "e2e4");
      const second = kind === "duplicate" ? first : command(initial, "d2d4");
      const responses = await Promise.all([
        submit(api, guest, first),
        submit(other, guest, second),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const accepted = gameSnapshotSchema.parse(
        responses.find((response) => response.statusCode === 200)!.json(),
      );
      expect(accepted.version).toBe(1);
      expect(accepted.moves).toHaveLength(1);
      expect(responses.find((response) => response.statusCode === 409)!.json()).toHaveProperty(
        "currentSnapshot",
        accepted,
      );
      expect(await api.database.db.$count(moves, eq(moves.gameId, initial.gameId))).toBe(1);
      expect(await snapshot(other, guest, initial.gameId)).toEqual(accepted);
    },
  );

  it("returns the current snapshot for stale, future, repeated and changed-payload accepted IDs", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const accepted = command(initial, "e2e4");
    const response = await submit(api, guest, accepted);
    const current = gameSnapshotSchema.parse(response.json());
    for (const retry of [
      accepted,
      { ...accepted, expectedVersion: 1, move: "e7e5" },
      {
        ...accepted,
        commandId: accepted.commandId.toUpperCase(),
        expectedVersion: 1,
        move: "e7e5",
      },
      command(initial, "d2d4"),
      { ...command(current, "e7e5"), expectedVersion: 99 },
    ]) {
      const conflict = await submit(api, guest, retry);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toHaveProperty("currentSnapshot", current);
    }
    expect(await snapshot(api, guest, initial.gameId)).toEqual(current);
  });

  it("rejects illegal and out-of-turn moves without advancing the game", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    for (const uci of ["e2e5", "e7e5", "e2e4q"]) {
      expect((await submit(api, guest, command(initial, uci))).statusCode).toBe(422);
    }
    expect(await snapshot(api, guest, initial.gameId)).toEqual(initial);
  });

  it("rolls back a real move insertion when the subsequent position update fails", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    let inserted = false;
    const failing = await harness.createApi({
      repository: (repository) => ({
        ...repository,
        write: (action) =>
          repository.write((tx) =>
            action({
              ...tx,
              appendMove: async (move) => {
                await tx.appendMove(move);
                inserted = true;
              },
              updatePosition: async () => {
                throw new Error("rollback-canary");
              },
            }),
          ),
      }),
    });
    const attempted = command(initial, "e2e4");
    const response = await submit(failing, guest, attempted);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("rollback-canary");
    expect(inserted).toBe(true);
    expect(await api.database.db.$count(moves, eq(moves.gameId, initial.gameId))).toBe(0);
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, initial.gameId)),
    ).toBe(0);
    expect(await snapshot(api, guest, initial.gameId)).toEqual(initial);
    expect((await submit(api, guest, attempted)).statusCode).toBe(200);
  });

  it("never combines an old game revision with newly committed moves in a snapshot", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const readStarted = Promise.withResolvers<void>();
    const moveCommitted = Promise.withResolvers<void>();
    const reader = await harness.createApi({
      repository: (repository) => ({
        ...repository,
        read: (action) =>
          repository.read((tx) =>
            action({
              ...tx,
              getMoves: async (id) => {
                readStarted.resolve();
                await moveCommitted.promise;
                return tx.getMoves(id);
              },
            }),
          ),
      }),
    });
    const reading = snapshot(reader, guest, initial.gameId);
    await readStarted.promise;
    try {
      const moved = await submit(api, guest, command(initial, "e2e4"));
      expect(moved.statusCode).toBe(200);
    } finally {
      moveCommitted.resolve();
    }
    expect(await reading).toEqual(initial);
    expect((await snapshot(api, guest, initial.gameId)).version).toBe(1);
  });
});

describe("natural results and database restoration", () => {
  it("persists checkmate atomically, releases the slot, and makes terminal retries safe", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const beforeMate = await play(api, guest, initial, FOOLS_MATE.slice(0, -1));
    const mating = command(beforeMate, "d8h4");
    const response = await submit(api, guest, mating);
    const completed = gameSnapshotSchema.parse(response.json());
    expect(completed).toMatchObject({
      state: "completed",
      result: "0-1",
      terminationReason: "checkmate",
      version: 4,
      legalMoves: [],
    });
    expect(completed.pgn).toContain('[Result "0-1"]');
    expect(completed.pgn.endsWith("0-1")).toBe(true);
    expect((await submit(api, guest, mating)).json()).toHaveProperty("currentSnapshot", completed);
    expect((await submit(api, guest, command(completed, "a2a3"))).json()).toHaveProperty(
      "code",
      "INVALID_GAME_STATE",
    );
    const [persisted] = await api.database.db
      .select()
      .from(games)
      .where(eq(games.id, initial.gameId));
    expect(persisted).toMatchObject({
      fen: completed.fen,
      pgn: completed.pgn,
      result: "0-1",
      terminationReason: "checkmate",
      version: 4,
    });
    const next = await createSandbox(api, guest);
    expect(next.gameId).not.toBe(initial.gameId);
    expect(await snapshot(api, guest, completed.gameId)).toEqual(completed);
  });

  it("rebuilds repetition after closing the API/pool and finishes exactly on ply eight", async () => {
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const halfway = await play(api, guest, initial, KNIGHT_CYCLE);
    await harness.close(api);
    api = await harness.createApi();
    expect(await snapshot(api, guest, initial.gameId)).toEqual(halfway);
    const completed = await play(api, guest, halfway, KNIGHT_CYCLE);
    expect(completed).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "threefold_repetition",
      version: 8,
    });
    expect(completed.moves).toHaveLength(8);
    await harness.close(api);
    api = await harness.createApi();
    expect(await snapshot(api, guest, initial.gameId)).toEqual(completed);
    expect((await createSandbox(api, guest)).version).toBe(0);
  });

  it.each([
    { name: "castling", history: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"] },
    { name: "en passant", history: ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"] },
    {
      name: "promotion",
      history: ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2", "b7a8q", "g2h1n"],
    },
  ])(
    "round-trips $name, including FEN, SAN and PGN, without a custom starting position",
    async ({ history }) => {
      const guest = await harness.guest(api);
      const current = await play(api, guest, await createSandbox(api, guest), history);
      await harness.close(api);
      api = await harness.createApi();
      expect(await snapshot(api, guest, current.gameId)).toEqual(current);
    },
  );

  it.each(["fen", "pgn", "san", "ply", "uci", "lifecycle"] as const)(
    "fails closed on corrupted persisted %s",
    async (field) => {
      const guest = await harness.guest(api);
      const current = await play(api, guest, await createSandbox(api, guest), ["e2e4"]);
      if (field === "fen" || field === "pgn") {
        await api.database.db
          .update(games)
          .set({ [field]: "corruption-canary" })
          .where(eq(games.id, current.gameId));
      } else if (field === "lifecycle") {
        await api.database.db
          .update(games)
          .set({ state: "completed", result: "1-0", terminationReason: "checkmate" })
          .where(eq(games.id, current.gameId));
      } else {
        const patch =
          field === "ply"
            ? { ply: 2 }
            : field === "uci"
              ? { uci: "e2e5" }
              : { san: "corruption-canary" };
        await api.database.db.update(moves).set(patch).where(eq(moves.gameId, current.gameId));
      }
      const before = await api.database.db.select().from(games).where(eq(games.id, current.gameId));
      const readPaths = [
        "/games/" + current.gameId,
        "/games/" + current.gameId + "/replay",
        "/games/" + current.gameId + "/pgn",
        ...(field === "lifecycle" ? [] : ["/sandbox/games/unfinished"]),
      ];
      const responses = [
        ...(await Promise.all(
          readPaths.map((url) =>
            api.app.inject({ method: "GET", url, headers: { cookie: guest.cookie } }),
          ),
        )),
        await submit(api, guest, command(current, "e7e5")),
        await api.app.inject({
          method: "POST",
          url: "/games/" + current.gameId + "/lifecycle",
          headers: { cookie: guest.cookie, origin: WEB_ORIGIN },
          payload: {
            gameId: current.gameId,
            expectedVersion: current.version,
            commandId: randomUUID(),
            action: "pause",
          },
        }),
      ];
      for (const response of responses) {
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain("corruption-canary");
      }
      expect(
        await api.database.db.select().from(games).where(eq(games.id, current.gameId)),
      ).toEqual(before);
      expect(await api.database.db.$count(moves, eq(moves.gameId, current.gameId))).toBe(1);
      expect(
        await api.database.db.$count(gameCommands, eq(gameCommands.gameId, current.gameId)),
      ).toBe(1);
    },
  );
});
