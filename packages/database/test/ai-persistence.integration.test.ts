import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  type AiReservationOwner,
  type AiTurnCommit,
  createGameRepository,
  type DatabaseConnection,
  gameCommands,
  gameParticipants,
  games,
  guestSessions,
  modelInvocations,
  moves,
  type NewGame,
  type NewParticipant,
  type ReserveAiTurn,
  type StoredInvocationResult,
  turnReservations,
} from "../src/index.js";

let database: DatabaseConnection;
let second: DatabaseConnection;
const guestIds: string[] = [];

beforeAll(() => {
  database = integrationDatabase();
  second = integrationDatabase();
});
afterAll(async () => {
  await Promise.all([database.close(), second.close()]);
});
afterEach(async () => {
  if (guestIds.length === 0) return;
  await database.db.transaction(async (tx) => {
    await tx.delete(games).where(inArray(games.ownerGuestSessionId, guestIds));
    await tx.delete(guestSessions).where(inArray(guestSessions.id, guestIds));
  });
  guestIds.length = 0;
});

const initialPosition = {
  state: "active" as const,
  result: "*" as const,
  terminationReason: null,
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  pgn: '[Result "*"]\n\n*',
  version: 0,
};
const whiteConfiguration = {
  provider: "openai" as const,
  modelId: "white-model",
  temperature: 0,
  maxOutputTokens: 128,
};
const blackConfiguration = {
  provider: "anthropic" as const,
  modelId: "black-model",
  reasoningEffort: "high",
};
const success: StoredInvocationResult = {
  ok: true,
  value: {
    move: "e2e4",
    latencyMs: 12.5,
    usage: { inputTokens: 0, outputTokens: null, totalTokens: null },
    providerRequestId: "request_123",
  },
};
const invalid: StoredInvocationResult = {
  ok: false,
  error: { kind: "model_invalid", reason: "illegal_move" },
  latencyMs: 3,
  usage: null,
};
const acceptedMove: AiTurnCommit = {
  position: {
    ...initialPosition,
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    pgn: '[Result "*"]\n\n1. e4 *',
    version: 1,
  },
  move: {
    ply: 1,
    uci: "e2e4",
    san: "e4",
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  },
};

async function guest() {
  const row = await createGameRepository(database).createGuest(
    createHash("sha256").update(randomUUID()).digest("hex"),
    3600,
  );
  guestIds.push(row.id);
  return row;
}

async function fixture(mode: "ai_vs_ai" | "ai_vs_human" = "ai_vs_ai") {
  const owner = await guest();
  const game = {
    ...initialPosition,
    id: randomUUID(),
    ownerGuestSessionId: owner.id,
    mode,
  } satisfies NewGame;
  const seats: NewParticipant[] = [
    { gameId: game.id, color: "white", seatType: "ai", ...whiteConfiguration },
    mode === "ai_vs_ai"
      ? { gameId: game.id, color: "black", seatType: "ai", ...blackConfiguration }
      : { gameId: game.id, color: "black", seatType: "human", guestSessionId: owner.id },
  ];
  await createGameRepository(database).write(async (tx) => {
    await tx.lockGuest(owner.id);
    await tx.insertGame(game, seats);
  });
  const request: ReserveAiTurn = {
    gameId: game.id,
    ownerGuestSessionId: owner.id,
    expectedVersion: 0,
    commandId: randomUUID(),
    executorId: randomUUID(),
    color: "white",
    leaseMs: 60_000,
  };
  return { owner, game, request };
}

async function reserve(request: ReserveAiTurn): Promise<AiReservationOwner> {
  const result = await createGameRepository(database).write((tx) => tx.reserveAiTurn(request));
  expect(result.status).toBe("reserved");
  if (result.status !== "reserved") throw new Error("Reservation fixture failed");
  return {
    gameId: request.gameId,
    ownerGuestSessionId: request.ownerGuestSessionId,
    reservationId: result.reservation.id,
    executorId: request.executorId,
  };
}

async function lifecycle(
  request: ReserveAiTurn,
  action: "pause" | "resume" | "abort",
  version: number,
  commandId: string = randomUUID(),
  connection = database,
) {
  return createGameRepository(connection).write(async (tx) => {
    await tx.lockGuest(request.ownerGuestSessionId);
    const game = await tx.lockGame(request.gameId);
    if (!game) throw new Error("Missing fixture");
    await tx.appendCommand({ gameId: game.id, commandId, kind: action, version: version + 1 });
    const updated = await tx.updatePosition(game.id, version, {
      ...game,
      version: version + 1,
      state: action === "pause" ? "paused" : action === "resume" ? "active" : "aborted",
      terminationReason: action === "abort" ? "aborted" : null,
    });
    if (!updated) throw new Error("Fixture revision conflict");
  });
}

async function expire(owner: AiReservationOwner) {
  await database.db
    .update(turnReservations)
    .set({
      createdAt: sql`clock_timestamp() - interval '2 minutes'`,
      leaseExpiresAt: sql`clock_timestamp() - interval '1 minute'`,
    })
    .where(eq(turnReservations.id, owner.reservationId));
}

describe("AI forward migration", () => {
  it("rolls back DDL atomically and upgrades populated sandbox games without altering history, receipts or ownership", async () => {
    const schemaName = "migration_ai_" + randomUUID().replaceAll("-", "");
    const migrations = await Promise.all(
      ["0001_guest_owned_games", "0002_game_command_receipts", "0003_ai_turn_persistence"].map(
        (name) => readFile(new URL(`../drizzle/${name}.sql`, import.meta.url), "utf8"),
      ),
    );
    async function apply(
      tx: Parameters<Parameters<typeof database.db.transaction>[0]>[0],
      migration: string,
    ) {
      await tx.execute(sql`set local search_path to ${sql.identifier(schemaName)}`);
      for (const statement of migration
        .split("--> statement-breakpoint")
        .filter((part) => part.trim())) {
        await tx.execute(sql.raw(statement.replaceAll('"public"', '"' + schemaName + '"')));
      }
    }
    try {
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`create schema ${sql.identifier(schemaName)}`);
        await apply(tx, migrations[0]!);
        const ownerId = randomUUID();
        const gameId = randomUUID();
        await tx.execute(
          sql`insert into guest_sessions(id, token_hash, expires_at) values (${ownerId}, ${"a".repeat(64)}, clock_timestamp() + interval '1 hour')`,
        );
        await tx.execute(
          sql`insert into games(id, owner_guest_session_id, is_sandbox, state, result, fen, pgn, version) values (${gameId}, ${ownerId}, true, 'paused', '*', 'old-fen', 'old-pgn', 2)`,
        );
        await tx.execute(
          sql`insert into game_participants(game_id, color, seat_type, guest_session_id) values (${gameId}, 'white', 'human', ${ownerId}), (${gameId}, 'black', 'human', null)`,
        );
        await tx.execute(
          sql`insert into moves(game_id, ply, uci, san, fen, command_id, version) values (${gameId}, 1, 'e2e4', 'e4', 'old-fen', ${randomUUID()}, 1)`,
        );
        await apply(tx, migrations[1]!);
        await tx.execute(
          sql`insert into game_commands(game_id, command_id, kind, version) values (${gameId}, ${randomUUID()}, 'pause', 2)`,
        );
      });
      async function oldData() {
        return database.db.transaction(async (tx) => {
          await tx.execute(sql`set local search_path to ${sql.identifier(schemaName)}`);
          return (
            await tx.execute(
              sql`select row_to_json(g) as game, (select json_agg(m order by ply) from moves m) as moves, (select json_agg(c order by version) from game_commands c) as commands from games g`,
            )
          ).rows;
        });
      }
      const before = await oldData();
      await expect(
        database.db.transaction(async (tx) => {
          await apply(tx, migrations[2]!);
          throw new Error("Injected migration rollback");
        }),
      ).rejects.toThrow("Injected migration rollback");
      expect(await oldData()).toEqual(before);
      const rolledBack = await database.db.execute(
        sql`select table_name from information_schema.tables where table_schema = ${schemaName} and table_name in ('turn_reservations', 'model_invocations')`,
      );
      expect(rolledBack.rows).toEqual([]);
      await database.db.transaction((tx) => apply(tx, migrations[2]!));
      const after = (await oldData()) as {
        game: Record<string, unknown>;
        moves: unknown;
        commands: unknown;
      }[];
      expect(after[0]!.game.mode).toBe("human_vs_human");
      delete after[0]!.game.mode;
      expect(after).toEqual(before);
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`set local search_path to ${sql.identifier(schemaName)}`);
        expect(
          (
            await tx.execute(
              sql`select color, seat_type, provider, model_id, temperature, reasoning_effort, max_output_tokens from game_participants order by color`,
            )
          ).rows,
        ).toEqual([
          {
            color: "white",
            seat_type: "human",
            provider: null,
            model_id: null,
            temperature: null,
            reasoning_effort: null,
            max_output_tokens: null,
          },
          {
            color: "black",
            seat_type: "human",
            provider: null,
            model_id: null,
            temperature: null,
            reasoning_effort: null,
            max_output_tokens: null,
          },
        ]);
      });
    } finally {
      await database.db.execute(sql`drop schema if exists ${sql.identifier(schemaName)} cascade`);
    }
  });
});

describe("AI configuration and relational constraints", () => {
  it.each(["ai_vs_ai", "ai_vs_human"] as const)(
    "persists %s seats independently and shares the existing unfinished-game slot",
    async (mode) => {
      const { game, request } = await fixture(mode);
      const seats = await createGameRepository(database).read((reader) =>
        reader.getParticipants(game.id),
      );
      expect(seats[0]).toMatchObject(whiteConfiguration);
      expect(seats[1]).toMatchObject(
        mode === "ai_vs_ai"
          ? blackConfiguration
          : {
              seatType: "human",
              provider: null,
              modelId: null,
              guestSessionId: game.ownerGuestSessionId,
            },
      );
      expect(
        await createGameRepository(database).read((reader) =>
          reader.findUnfinishedGame(game.ownerGuestSessionId),
        ),
      ).toMatchObject({ id: game.id, mode });
      for (const replacement of [
        { mode: "ai_vs_ai" },
        { mode: "ai_vs_human", state: "paused" },
        { mode: "human_vs_human", isSandbox: true },
      ] as const) {
        await expect(
          second.db.insert(games).values({ ...game, ...replacement, id: randomUUID() }),
        ).rejects.toThrow();
      }
      await lifecycle(request, "abort", 0);
      await expect(
        database.db.insert(games).values({ ...game, id: randomUUID() }),
      ).resolves.toBeDefined();
    },
  );

  it("allows the same provider/model on both colors while keeping different parameters", async () => {
    const { game } = await fixture();
    await database.db
      .update(gameParticipants)
      .set({ ...whiteConfiguration, temperature: 0.9, maxOutputTokens: 256 })
      .where(and(eq(gameParticipants.gameId, game.id), eq(gameParticipants.color, "black")));
    const seats = await createGameRepository(database).read((reader) =>
      reader.getParticipants(game.id),
    );
    expect(seats.map((seat) => seat.temperature)).toEqual([0, 0.9]);
    expect(seats.map((seat) => seat.maxOutputTokens)).toEqual([128, 256]);
  });

  it("rejects missing/contradictory AI identity and out-of-range configuration", async () => {
    const { game } = await fixture("ai_vs_human");
    for (const patch of [
      { provider: null },
      { modelId: null },
      { modelId: "" },
      { modelId: "bad model" },
      { modelId: "x".repeat(201) },
      { temperature: -1 },
      { temperature: Infinity },
      { temperature: NaN },
      { reasoningEffort: "HIGH\n" },
      { maxOutputTokens: 0 },
      { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { guestSessionId: game.ownerGuestSessionId },
    ]) {
      await expect(
        database.db
          .update(gameParticipants)
          .set(patch)
          .where(and(eq(gameParticipants.gameId, game.id), eq(gameParticipants.color, "white"))),
      ).rejects.toThrow();
    }
    await expect(
      database.db
        .update(gameParticipants)
        .set(whiteConfiguration)
        .where(and(eq(gameParticipants.gameId, game.id), eq(gameParticipants.color, "black"))),
    ).rejects.toThrow();
    await expect(
      database.db.update(games).set({ isSandbox: true }).where(eq(games.id, game.id)),
    ).rejects.toThrow();
    await expect(
      database.db.execute(
        sql`update game_participants set provider = 'unknown' where game_id = ${game.id}`,
      ),
    ).rejects.toThrow();
  });

  it("rolls back the game and both seats when an AI configuration insert fails", async () => {
    const owner = await guest();
    const gameId = randomUUID();
    await expect(
      createGameRepository(database).write((tx) =>
        tx.insertGame(
          { ...initialPosition, id: gameId, ownerGuestSessionId: owner.id, mode: "ai_vs_ai" },
          [
            { gameId, color: "white", seatType: "ai", ...whiteConfiguration },
            { gameId, color: "black", seatType: "ai" },
          ],
        ),
      ),
    ).rejects.toThrow();
    expect(await database.db.$count(games, eq(games.id, gameId))).toBe(0);
    expect(await database.db.$count(gameParticipants, eq(gameParticipants.gameId, gameId))).toBe(0);
  });

  it("enforces reservation foreign keys, identity, revision and one pending turn even for direct racing SQL", async () => {
    const { request } = await fixture("ai_vs_human");
    const otherGuest = await guest();
    const values = {
      gameId: request.gameId,
      ownerGuestSessionId: request.ownerGuestSessionId,
      commandId: request.commandId,
      expectedVersion: 0,
      color: "white" as const,
      executorId: request.executorId,
      leaseExpiresAt: sql`clock_timestamp() + interval '1 minute'`,
    };
    for (const patch of [
      { ownerGuestSessionId: otherGuest.id },
      { color: "black" as const },
      { expectedVersion: -1 },
      { expectedVersion: Number.MAX_SAFE_INTEGER },
      { seatType: "human" as const },
      { status: "committed" as const },
      { leaseExpiresAt: sql`clock_timestamp() - interval '1 minute'` },
    ]) {
      await expect(
        database.db.insert(turnReservations).values({ ...values, ...patch }),
      ).rejects.toThrow();
    }
    const results = await Promise.allSettled([
      database.db.insert(turnReservations).values(values),
      second.db
        .insert(turnReservations)
        .values({ ...values, commandId: randomUUID(), expectedVersion: 1 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(
      await database.db.$count(turnReservations, eq(turnReservations.gameId, request.gameId)),
    ).toBe(1);
  });
});

describe("durable reservation ownership and recovery", () => {
  it("rolls back a new reservation and an invalidating pause without losing ownership or receipts", async () => {
    const { request } = await fixture();
    const repository = createGameRepository(database);
    await expect(
      repository.write(async (tx) => {
        expect((await tx.reserveAiTurn(request)).status).toBe("reserved");
        throw new Error("Injected reservation rollback");
      }),
    ).rejects.toThrow("Injected reservation rollback");
    expect(await repository.read((reader) => reader.getTurnReservations(request.gameId))).toEqual(
      [],
    );
    const owner = await reserve(request);
    await repository.write((tx) => tx.beginAiInvocation(owner));
    await expect(
      repository.write(async (tx) => {
        await tx.lockGuest(request.ownerGuestSessionId);
        await tx.lockGame(request.gameId);
        await tx.appendCommand({
          gameId: request.gameId,
          commandId: randomUUID(),
          kind: "pause",
          version: 1,
        });
        await tx.updatePosition(request.gameId, 0, {
          ...initialPosition,
          state: "paused",
          version: 1,
        });
        expect((await tx.getTurnReservations(request.gameId))[0]).toMatchObject({
          status: "cancelled",
        });
        throw new Error("Injected pause rollback");
      }),
    ).rejects.toThrow("Injected pause rollback");
    expect(await repository.read((reader) => reader.getGame(request.gameId))).toMatchObject(
      initialPosition,
    );
    expect(
      (await repository.read((reader) => reader.getTurnReservations(request.gameId)))[0],
    ).toMatchObject({ status: "reserved" });
    expect(
      (await repository.read((reader) => reader.getModelInvocations(request.gameId)))[0],
    ).toMatchObject({ status: "pending" });
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, request.gameId))).toBe(0);
  });

  it.each([true, false])(
    "grants one executor across separate pools (same command: %s)",
    async (sameCommand) => {
      const { request } = await fixture();
      const other = {
        ...request,
        executorId: randomUUID(),
        commandId: sameCommand ? request.commandId.toUpperCase() : randomUUID(),
      };
      const results = await Promise.all([
        createGameRepository(database).write((tx) => tx.reserveAiTurn(request)),
        createGameRepository(second).write((tx) => tx.reserveAiTurn(other)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        sameCommand ? "duplicate" : "busy",
        "reserved",
      ]);
      const winnerIndex = results.findIndex((result) => result.status === "reserved");
      const winning = results[winnerIndex]!;
      if (winning.status !== "reserved") throw new Error("No reservation winner");
      const winner = winnerIndex === 0 ? request : other;
      const owner = {
        gameId: request.gameId,
        ownerGuestSessionId: request.ownerGuestSessionId,
        executorId: winner.executorId,
        reservationId: winning.reservation.id,
      };
      const repository = createGameRepository(second);
      await expect(
        repository.write((tx) => tx.beginAiInvocation({ ...owner, executorId: randomUUID() })),
      ).rejects.toMatchObject({ code: "RESERVATION_LOST" });
      await expect(
        repository.write((tx) => tx.renewAiTurn({ ...owner, executorId: randomUUID() }, 60_000)),
      ).rejects.toMatchObject({ code: "RESERVATION_LOST" });
      expect((await repository.write((tx) => tx.beginAiInvocation(owner))).attempt).toBe(1);
      await expect(repository.write((tx) => tx.beginAiInvocation(owner))).rejects.toMatchObject({
        code: "INVALID_AI_STATE",
      });
    },
  );

  it("checks guest ownership before exposing duplicate/conflict state", async () => {
    const { request } = await fixture();
    const stranger = await guest();
    const owner = await reserve(request);
    const repository = createGameRepository(second);
    await expect(
      repository.write((tx) => tx.reserveAiTurn({ ...request, ownerGuestSessionId: stranger.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repository.write((tx) =>
        tx.beginAiInvocation({ ...owner, ownerGuestSessionId: stranger.id }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await database.db
      .update(guestSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
        expiresAt: sql`clock_timestamp() - interval '1 hour'`,
      })
      .where(eq(guestSessions.id, request.ownerGuestSessionId));
    await expect(repository.write((tx) => tx.reserveAiTurn(request))).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("keeps accepted receipts and reservation command IDs exclusive across kinds and payloads", async () => {
    const { request } = await fixture();
    await reserve(request);
    const repository = createGameRepository(database);
    expect(
      await repository.write((tx) =>
        tx.hasCommand(request.gameId, request.commandId.toUpperCase()),
      ),
    ).toBe(true);
    expect(
      await repository.write((tx) =>
        tx.reserveAiTurn({ ...request, expectedVersion: 99, color: "black" }),
      ),
    ).toEqual({ status: "duplicate" });
    await expect(lifecycle(request, "pause", 0, request.commandId)).rejects.toMatchObject({
      code: "AI_COMMAND_RESERVED",
    });
    const pauseId = randomUUID();
    await lifecycle(request, "pause", 0, pauseId);
    expect(
      await repository.write((tx) => tx.reserveAiTurn({ ...request, commandId: pauseId })),
    ).toEqual({ status: "duplicate" });
    expect(
      await repository.write((tx) => tx.reserveAiTurn({ ...request, commandId: randomUUID() })),
    ).toEqual({ status: "conflict" });
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, request.gameId))).toBe(1);
  });

  it.each(["pause", "abort"] as const)(
    "%s cancels an in-flight invocation and rejects late provider results",
    async (action) => {
      const { request } = await fixture();
      const owner = await reserve(request);
      const repository = createGameRepository(database);
      const attempt = await repository.write((tx) => tx.beginAiInvocation(owner));
      await lifecycle(request, action, 0, randomUUID(), second);
      await expect(
        repository.write((tx) => tx.recordAiInvocation(owner, attempt.id, success)),
      ).rejects.toMatchObject({ code: "RESERVATION_LOST" });
      await expect(
        repository.write((tx) => tx.commitAiTurn(owner, acceptedMove)),
      ).rejects.toMatchObject({ code: "RESERVATION_LOST" });
      expect(
        (await repository.read((reader) => reader.getTurnReservations(request.gameId)))[0],
      ).toMatchObject({ status: "cancelled" });
      expect(
        (await repository.read((reader) => reader.getModelInvocations(request.gameId)))[0],
      ).toMatchObject({ status: "abandoned", latencyMs: null, usageReported: false });
      expect(await database.db.$count(moves, eq(moves.gameId, request.gameId))).toBe(0);
    },
  );

  it("renews only a live lease and recovers an abandoned request through explicit pause/resume", async () => {
    const { request } = await fixture();
    const owner = await reserve(request);
    const repository = createGameRepository(second);
    const before = (
      await repository.read((reader) => reader.getTurnReservations(request.gameId))
    )[0]!;
    await repository.write((tx) => tx.renewAiTurn(owner, 120_000));
    const renewed = (
      await repository.read((reader) => reader.getTurnReservations(request.gameId))
    )[0]!;
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(before.leaseExpiresAt.getTime());
    const invocation = await repository.write((tx) => tx.beginAiInvocation(owner));
    await expire(owner);
    await expect(repository.write((tx) => tx.renewAiTurn(owner, 60_000))).rejects.toMatchObject({
      code: "RESERVATION_LOST",
    });
    await expect(
      repository.write((tx) => tx.recordAiInvocation(owner, invocation.id, success)),
    ).rejects.toMatchObject({ code: "RESERVATION_LOST" });
    expect(
      await repository.write((tx) => tx.reserveAiTurn({ ...request, commandId: randomUUID() })),
    ).toEqual({ status: "recovery_required" });
    expect(await repository.read((reader) => reader.getGame(request.gameId))).toMatchObject({
      state: "active",
      version: 0,
    });
    await lifecycle(request, "pause", 0);
    expect(
      (await repository.read((reader) => reader.getTurnReservations(request.gameId)))[0],
    ).toMatchObject({ status: "abandoned" });
    await expect(
      repository.write((tx) =>
        tx.reserveAiTurn({ ...request, expectedVersion: 1, commandId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_AI_STATE" });
    await lifecycle(request, "resume", 1);
    const next = await reserve({
      ...request,
      expectedVersion: 2,
      commandId: randomUUID(),
      executorId: randomUUID(),
    });
    await expect(repository.write((tx) => tx.beginAiInvocation(owner))).rejects.toMatchObject({
      code: "RESERVATION_LOST",
    });
    expect((await repository.write((tx) => tx.beginAiInvocation(next))).attempt).toBe(1);
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, request.gameId))).toBe(2);
  });
});

describe("normalized invocation attempts and atomic completion", () => {
  it("persists effective configuration, normalized errors, zero/partial/unavailable usage, and commits a move once", async () => {
    const { request } = await fixture();
    const owner = await reserve(request);
    const repository = createGameRepository(database);
    const first = await repository.write((tx) => tx.beginAiInvocation(owner));
    await repository.write((tx) => tx.recordAiInvocation(owner, first.id, invalid));
    const next = await repository.write((tx) => tx.beginAiInvocation(owner));
    expect(next).toMatchObject({ ...whiteConfiguration, attempt: 2 });
    await repository.write((tx) => tx.recordAiInvocation(owner, next.id, success));
    const attempts = await repository.read((reader) => reader.getModelInvocations(request.gameId));
    expect(attempts[0]).toMatchObject({
      status: "model_invalid",
      invalidReason: "illegal_move",
      latencyMs: 3,
      usageReported: false,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(attempts[1]).toMatchObject({
      status: "succeeded",
      move: "e2e4",
      commentary: null,
      latencyMs: 12.5,
      usageReported: true,
      inputTokens: 0,
      outputTokens: null,
      totalTokens: null,
      providerRequestId: "request_123",
    });
    const commits = await Promise.allSettled([
      repository.write((tx) => tx.commitAiTurn(owner, acceptedMove)),
      createGameRepository(second).write((tx) => tx.commitAiTurn(owner, acceptedMove)),
    ]);
    expect(commits.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await database.db.$count(moves, eq(moves.gameId, request.gameId))).toBe(1);
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, request.gameId))).toBe(1);
    expect(await repository.read((reader) => reader.getGame(request.gameId))).toMatchObject(
      acceptedMove.position,
    );
    expect(
      await repository.write((tx) => tx.reserveAiTurn({ ...request, expectedVersion: 1 })),
    ).toEqual({ status: "duplicate" });
  });

  it("rolls back an invocation and a completed turn after actual SQL writes", async () => {
    const { request } = await fixture();
    const owner = await reserve(request);
    const repository = createGameRepository(database);
    await expect(
      repository.write(async (tx) => {
        await tx.beginAiInvocation(owner);
        throw new Error("Injected attempt rollback");
      }),
    ).rejects.toThrow("Injected attempt rollback");
    expect(await repository.read((reader) => reader.getModelInvocations(request.gameId))).toEqual(
      [],
    );
    const attempt = await repository.write((tx) => tx.beginAiInvocation(owner));
    await expect(
      repository.write(async (tx) => {
        await tx.recordAiInvocation(owner, attempt.id, success);
        await tx.commitAiTurn(owner, acceptedMove);
        throw new Error("Injected commit rollback");
      }),
    ).rejects.toThrow("Injected commit rollback");
    expect(await repository.read((reader) => reader.getGame(request.gameId))).toMatchObject(
      initialPosition,
    );
    expect(await database.db.$count(moves, eq(moves.gameId, request.gameId))).toBe(0);
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, request.gameId))).toBe(0);
    expect(
      (await repository.read((reader) => reader.getModelInvocations(request.gameId)))[0],
    ).toMatchObject({ status: "pending", finishedAt: null });
    expect(
      (await repository.read((reader) => reader.getTurnReservations(request.gameId)))[0],
    ).toMatchObject({ status: "reserved", endedAt: null });
  });

  it("permits only two invalid-output retries and records technical loss with a receipt and no move", async () => {
    const { request } = await fixture();
    const owner = await reserve(request);
    const repository = createGameRepository(database);
    const loss: AiTurnCommit = {
      position: {
        ...initialPosition,
        state: "completed",
        result: "0-1",
        terminationReason: "model_technical_loss",
        pgn: '[Result "0-1"]\n\n0-1',
        version: 1,
      },
    };
    for (let number = 1; number <= 3; number++) {
      const attempt = await repository.write((tx) => tx.beginAiInvocation(owner));
      expect(attempt.attempt).toBe(number);
      await repository.write((tx) => tx.recordAiInvocation(owner, attempt.id, invalid));
      if (number < 3) {
        await expect(repository.write((tx) => tx.commitAiTurn(owner, loss))).rejects.toMatchObject({
          code: "INVALID_AI_STATE",
        });
      }
    }
    await expect(repository.write((tx) => tx.beginAiInvocation(owner))).rejects.toMatchObject({
      code: "INVALID_AI_STATE",
    });
    await repository.write((tx) => tx.commitAiTurn(owner, loss));
    expect(
      await repository.read((reader) => reader.findUnfinishedGame(request.ownerGuestSessionId)),
    ).toBeUndefined();
    expect(
      (
        await database.db.select().from(gameCommands).where(eq(gameCommands.gameId, request.gameId))
      )[0],
    ).toMatchObject({ kind: "technical_loss", version: 1, commandId: request.commandId });
    expect(await database.db.$count(moves, eq(moves.gameId, request.gameId))).toBe(0);
  });

  it.each(["provider_auth", "provider_quota", "provider_timeout", "provider_unavailable"] as const)(
    "persists %s as a paused outcome without retrying or awarding a loss",
    async (kind) => {
      const { request } = await fixture();
      const owner = await reserve(request);
      const repository = createGameRepository(database);
      const attempt = await repository.write((tx) => tx.beginAiInvocation(owner));
      await repository.write((tx) =>
        tx.recordAiInvocation(owner, attempt.id, {
          ok: false,
          error: { kind },
          latencyMs: 0,
          usage: null,
        }),
      );
      await expect(repository.write((tx) => tx.beginAiInvocation(owner))).rejects.toMatchObject({
        code: "INVALID_AI_STATE",
      });
      await repository.write((tx) =>
        tx.commitAiTurn(owner, { position: { ...initialPosition, state: "paused", version: 1 } }),
      );
      expect(
        await repository.read((reader) => reader.findUnfinishedGame(request.ownerGuestSessionId)),
      ).toMatchObject({ state: "paused", result: "*", terminationReason: null });
      expect(await database.db.$count(moves, eq(moves.gameId, request.gameId))).toBe(0);
    },
  );

  it("rejects credentials, raw payloads, exception messages and malformed telemetry without retaining diagnostics", async () => {
    const { request } = await fixture();
    const owner = await reserve(request);
    const repository = createGameRepository(database);
    const attempt = await repository.write((tx) => tx.beginAiInvocation(owner));
    const secret = "placeholder-credential-do-not-retain";
    const malformed = [
      { ...invalid, apiKey: secret },
      { ...invalid, error: { kind: "provider_auth", message: secret } },
      { ...invalid, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, raw: secret } },
      { ...invalid, providerRequestId: `https://provider.test/?key=${secret}` },
      { ...invalid, latencyMs: Infinity },
    ];
    for (const result of malformed) {
      await expect(
        repository.write((tx) =>
          tx.recordAiInvocation(owner, attempt.id, result as StoredInvocationResult),
        ),
      ).rejects.toMatchObject({ code: "INVALID_AI_DATA", message: "INVALID_AI_DATA" });
    }
    const rows = await repository.read((reader) => reader.getModelInvocations(request.gameId));
    expect(rows[0]).toMatchObject({ status: "pending", errorKind: null, latencyMs: null });
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("enforces attempt/telemetry constraints in PostgreSQL and cascades only the deleted game's AI records", async () => {
    const first = await fixture();
    const other = await fixture();
    const owner = await reserve(first.request);
    const otherOwner = await reserve(other.request);
    const repository = createGameRepository(database);
    const attempt = await repository.write((tx) => tx.beginAiInvocation(owner));
    await repository.write((tx) => tx.beginAiInvocation(otherOwner));
    for (const patch of [
      { attempt: 0 },
      { attempt: 4 },
      { gameId: other.request.gameId },
      { status: "provider_error" as const },
      { status: "succeeded" as const },
      { usageReported: false, inputTokens: 0 },
    ]) {
      await expect(
        database.db.update(modelInvocations).set(patch).where(eq(modelInvocations.id, attempt.id)),
      ).rejects.toThrow();
    }
    await expect(
      database.db.insert(modelInvocations).values({
        reservationId: owner.reservationId,
        gameId: owner.gameId,
        attempt: 2,
        ...whiteConfiguration,
      }),
    ).rejects.toThrow();
    await repository.write((tx) => tx.recordAiInvocation(owner, attempt.id, success));
    for (const patch of [
      { latencyMs: -1 },
      { latencyMs: NaN },
      { inputTokens: -1 },
      { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
      { move: "e2e2" },
      { commentary: "a".repeat(2001) },
      { providerRequestId: "request\n" },
    ]) {
      await expect(
        database.db.update(modelInvocations).set(patch).where(eq(modelInvocations.id, attempt.id)),
      ).rejects.toThrow();
    }
    await database.db.delete(games).where(eq(games.id, owner.gameId));
    expect(
      await database.db.$count(turnReservations, eq(turnReservations.gameId, owner.gameId)),
    ).toBe(0);
    expect(
      await database.db.$count(modelInvocations, eq(modelInvocations.gameId, owner.gameId)),
    ).toBe(0);
    expect(
      await database.db.$count(modelInvocations, eq(modelInvocations.gameId, otherOwner.gameId)),
    ).toBe(1);
    expect(
      await database.db.$count(guestSessions, eq(guestSessions.id, owner.ownerGuestSessionId)),
    ).toBe(1);
  });
});
