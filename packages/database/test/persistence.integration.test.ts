import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import {
  aiTurnReservations,
  aiTurns,
  createGameRepository,
  type DatabaseConnection,
  gameCommands,
  gameParticipants,
  games,
  guestSessions,
  modelInvocations,
  moves,
  type NewGame,
  type NewMove,
  runMigrations,
} from "../src/index.js";

let database: DatabaseConnection;
const guestIds: string[] = [];

beforeAll(() => {
  database = integrationDatabase();
});
afterAll(async () => {
  await database.close();
});
afterEach(async () => {
  if (guestIds.length === 0) return;
  await database.db.transaction(async (tx) => {
    await tx.delete(games).where(inArray(games.ownerGuestSessionId, guestIds));
    await tx.delete(guestSessions).where(inArray(guestSessions.id, guestIds));
  });
  guestIds.length = 0;
});

async function guest() {
  const result = await createGameRepository(database).createGuest(
    createHash("sha256").update(randomUUID()).digest("hex"),
    3600,
  );
  guestIds.push(result.id);
  return result;
}

function gameValues(ownerGuestSessionId: string): NewGame {
  return {
    id: randomUUID(),
    ownerGuestSessionId,
    state: "active",
    result: "*",
    terminationReason: null,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    pgn: '[Result "*"]\n\n*',
  };
}

async function game() {
  const owner = await guest();
  const [created] = await database.db.insert(games).values(gameValues(owner.id)).returning();
  if (!created) throw new Error("Fixture insertion failed");
  return { ...created, ownerGuestSessionId: owner.id };
}

function moveValues(gameId: string): NewMove {
  return {
    gameId,
    ply: 1,
    uci: "e2e4",
    san: "e4",
    fen: "position-fixture",
    version: 1,
    commandId: randomUUID(),
  };
}

async function aiTurn() {
  const created = await game();
  const [turn] = await database.db
    .insert(aiTurns)
    .values({ gameId: created.id, ply: 1, color: "white", attemptCount: 1 })
    .returning();
  if (!turn) throw new Error("Fixture insertion failed");
  return turn;
}

async function invocation(outcome: "accepted" | "in_flight" = "accepted") {
  const turn = await aiTurn();
  const [attempt] = await database.db
    .insert(modelInvocations)
    .values({
      turnId: turn.id,
      attemptNumber: 1,
      reservationId: randomUUID(),
      commandId: randomUUID(),
      expectedVersion: 0,
      provider: "openai",
      modelId: "fixture",
      effectiveParameters: { temperature: 0 },
      outcome,
      durationMs: outcome === "accepted" ? 1 : null,
    })
    .returning();
  if (!attempt) throw new Error("Fixture insertion failed");
  return { turn, attempt };
}

async function aiParticipant() {
  const created = await game();
  const [seat] = await database.db
    .insert(gameParticipants)
    .values({
      gameId: created.id,
      color: "white",
      seatType: "ai",
      provider: "google",
      modelId: "models/fixture",
      parameters: { temperature: 0, reasoningEffort: "high", maxOutputTokens: 1000 },
    })
    .returning();
  if (!seat) throw new Error("Fixture insertion failed");
  return { created, seat };
}

async function reservation() {
  const created = await game();
  const [row] = await database.db
    .insert(aiTurnReservations)
    .values({
      gameId: created.id,
      reservationId: randomUUID(),
      commandId: randomUUID(),
      expectedVersion: 0,
    })
    .returning();
  if (!row) throw new Error("Fixture insertion failed");
  return row;
}

describe("reviewed PostgreSQL migration and structural constraints", () => {
  it.each([
    {
      name: "negative invalid-output count",
      patch: { invalidOutputCount: -1 },
      constraint: "ai_turns_budget_check",
    },
    {
      name: "more than three invalid outputs",
      patch: { invalidOutputCount: 4, attemptCount: 4 },
      constraint: "ai_turns_budget_check",
    },
    {
      name: "invalid outputs exceeding dispatched attempts",
      patch: { invalidOutputCount: 2 },
      constraint: "ai_turns_budget_check",
    },
    {
      name: "negative attempt count",
      patch: { attemptCount: -1 },
      constraint: "ai_turns_budget_check",
    },
    { name: "black on an odd ply", patch: { color: "black" }, constraint: "ai_turns_color_check" },
  ] as const)("rejects AI turn with $name", async ({ patch, constraint }) => {
    const turn = await aiTurn();
    await expect(
      database.db.update(aiTurns).set(patch).where(eq(aiTurns.id, turn.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
  });

  it("rejects an accepted move at a different ply even when that move exists", async () => {
    const turn = await aiTurn();
    await database.db.insert(moves).values({ ...moveValues(turn.gameId), ply: 2 });
    await expect(
      database.db.update(aiTurns).set({ acceptedMovePly: 2 }).where(eq(aiTurns.id, turn.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "ai_turns_ply_check" } });
  });

  it("requires the accepted move to exist at the AI turn's ply", async () => {
    const turn = await aiTurn();
    await expect(
      database.db.update(aiTurns).set({ acceptedMovePly: 1 }).where(eq(aiTurns.id, turn.id)),
    ).rejects.toMatchObject({
      cause: {
        code: "23503",
        constraint: "ai_turns_game_id_accepted_move_ply_moves_game_id_ply_fk",
      },
    });
  });

  it("rejects a second logical AI turn at the same game ply", async () => {
    const turn = await aiTurn();
    await expect(
      database.db.insert(aiTurns).values({ ...turn, id: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "ai_turns_ply_unique" } });
  });

  it.each([
    {
      name: "duplicate attempt number with a new reservation",
      patch: { reservationId: randomUUID() },
      constraint: "model_invocations_attempt_unique",
    },
    {
      name: "second pending attempt in the same reservation",
      patch: { attemptNumber: 2 },
      constraint: "model_invocations_pending_unique",
    },
  ] as const)("rejects $name", async ({ patch, constraint }) => {
    const { attempt } = await invocation("in_flight");
    await expect(
      database.db.insert(modelInvocations).values({ ...attempt, id: randomUUID(), ...patch }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint } });
  });

  it.each([
    {
      name: "negative duration on a completed attempt",
      patch: { durationMs: -1 },
      constraint: "model_invocations_usage_check",
    },
    {
      name: "negative expected revision",
      patch: { expectedVersion: -1 },
      constraint: "model_invocations_sequence_check",
    },
    {
      name: "zero attempt number",
      patch: { attemptNumber: 0 },
      constraint: "model_invocations_sequence_check",
    },
    {
      name: "token count without reported usage",
      patch: { inputTokens: 0 },
      constraint: "model_invocations_usage_check",
    },
    {
      name: "negative reported input tokens",
      patch: { usageReported: true, inputTokens: -1 },
      constraint: "model_invocations_usage_check",
    },
    {
      name: "reported total tokens above the safe-integer bound",
      patch: { usageReported: true, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
      constraint: "model_invocations_usage_check",
    },
    {
      name: "provider failure without an error code",
      patch: { outcome: "provider_error" },
      constraint: "model_invocations_result_check",
    },
    {
      name: "discarded result with an error reason but no code",
      patch: { outcome: "discarded", errorReason: "network" },
      constraint: "model_invocations_error_check",
    },
    {
      name: "model-invalid outcome with a provider-auth code",
      patch: { outcome: "model_invalid", errorCode: "provider_auth" },
      constraint: "model_invocations_result_check",
    },
    {
      name: "commentary on a provider failure",
      patch: { outcome: "provider_error", errorCode: "provider_auth", commentary: "unaccepted" },
      constraint: "model_invocations_result_check",
    },
    {
      name: "accepted commentary longer than 2000 characters",
      patch: { commentary: "x".repeat(2001) },
      constraint: "model_invocations_commentary_check",
    },
    {
      name: "model ID containing a query string",
      patch: { modelId: "model?key=secret" },
      constraint: "model_invocations_model_id_check",
    },
  ] as const)("rejects invocation with $name", async ({ patch, constraint }) => {
    const { attempt } = await invocation();
    await expect(
      database.db.update(modelInvocations).set(patch).where(eq(modelInvocations.id, attempt.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
  });

  it("cascades private AI turns and invocations when their game is deleted", async () => {
    const { turn } = await invocation();
    await database.db.delete(games).where(eq(games.id, turn.gameId));
    expect(await database.db.$count(aiTurns, eq(aiTurns.gameId, turn.gameId))).toBe(0);
    expect(await database.db.$count(modelInvocations, eq(modelInvocations.turnId, turn.id))).toBe(
      0,
    );
  });

  it("rejects a second reservation for the same game", async () => {
    const row = await reservation();
    await expect(
      database.db
        .insert(aiTurnReservations)
        .values({ ...row, reservationId: randomUUID(), commandId: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "ai_turn_reservations_pkey" } });
  });

  it.each([
    {
      name: "negative expected revision",
      patch: { expectedVersion: -1 },
      constraint: "ai_turn_reservations_version_check",
    },
    {
      name: "expected revision above the safe-integer bound",
      patch: { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      constraint: "ai_turn_reservations_version_check",
    },
  ])("rejects a reservation with $name", async ({ patch, constraint }) => {
    const row = await reservation();
    await expect(
      database.db
        .update(aiTurnReservations)
        .set(patch)
        .where(eq(aiTurnReservations.gameId, row.gameId)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
  });

  it("rejects an accepted state in the execution-reservation table", async () => {
    const row = await reservation();
    await expect(
      database.db.execute(
        sql`update ai_turn_reservations set state = 'accepted' where game_id = ${row.gameId}`,
      ),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "ai_turn_reservations_state_check" },
    });
  });

  it("requires a reservation's game to exist", async () => {
    const row = await reservation();
    await expect(
      database.db
        .update(aiTurnReservations)
        .set({ gameId: randomUUID() })
        .where(eq(aiTurnReservations.gameId, row.gameId)),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "ai_turn_reservations_game_id_games_id_fk" },
    });
  });

  it("keeps reservations separate from accepted receipts and cascades game deletion", async () => {
    const row = await reservation();
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, row.gameId))).toBe(0);
    await database.db.delete(games).where(eq(games.id, row.gameId));
    expect(
      await database.db.$count(aiTurnReservations, eq(aiTurnReservations.gameId, row.gameId)),
    ).toBe(0);
  });

  describe.each([
    {
      name: "participant parameters",
      table: gameParticipants,
      column: gameParticipants.parameters,
      constraint: "game_participants_parameters_check",
      nullable: true,
      create: async () => (await aiParticipant()).seat.id,
    },
    {
      name: "invocation effective parameters",
      table: modelInvocations,
      column: modelInvocations.effectiveParameters,
      constraint: "model_invocations_parameters_check",
      nullable: false,
      create: async () => (await invocation()).attempt.id,
    },
  ])("$name", ({ table, column, constraint, nullable, create }) => {
    async function declaredCheck(json: string | null) {
      const check = getTableConfig(table).checks.find((check) => check.name === constraint);
      if (!check) throw new Error(`Missing constraint: ${constraint}`);
      return (
        await database.db.execute(sql`
          select ${check.value} as valid
          from (select ${json}::jsonb as ${sql.identifier(column.name)}) as ${table}
        `)
      ).rows;
    }

    it.each([
      { name: "empty object", json: "{}" },
      { name: "zero temperature", json: '{"temperature":0}' },
      { name: "fractional temperature", json: '{"temperature":0.5}' },
      { name: "maximum temperature", json: '{"temperature":9007199254740991}' },
      { name: "minimum output-token limit", json: '{"maxOutputTokens":1}' },
      { name: "maximum output-token limit", json: '{"maxOutputTokens":9007199254740991}' },
      { name: "integral decimal output-token limit", json: '{"maxOutputTokens":1.0}' },
      { name: "one-character reasoning effort", json: '{"reasoningEffort":"0"}' },
      { name: "reasoning effort punctuation", json: '{"reasoningEffort":"high_2-x"}' },
      { name: "64-character reasoning effort", json: `{"reasoningEffort":"${"x".repeat(64)}"}` },
      {
        name: "all allowed keys",
        json: '{"temperature":0,"reasoningEffort":"high","maxOutputTokens":1000}',
      },
      // Raw JSON keeps precision and size that a JavaScript number cannot represent.
      { name: "512-byte object", json: `{"temperature": 0.${"0".repeat(492)}1}` },
    ])("accepts $name in the declaration and migrated table", async ({ json }) => {
      expect(await declaredCheck(json)).toEqual([{ valid: true }]);
      const id = await create();
      await database.db.execute(sql`
        update ${table} set ${sql.identifier(column.name)} = ${json}::jsonb where id = ${id}
      `);
      expect(
        (
          await database.db.execute(sql`
            select ${column} = ${json}::jsonb as matches from ${table} where id = ${id}
          `)
        ).rows,
      ).toEqual([{ matches: true }]);
    });

    it.each([
      { name: "JSON null", json: "null" },
      { name: "array", json: "[]" },
      { name: "string", json: '"parameters"' },
      { name: "number", json: "1" },
      { name: "boolean", json: "true" },
      { name: "credential field", json: '{"apiKey":"sentinel"}' },
      { name: "unknown nested field", json: '{"nested":{"key":"sentinel"}}' },
      { name: "string temperature", json: '{"temperature":"0"}' },
      { name: "null temperature", json: '{"temperature":null}' },
      { name: "boolean temperature", json: '{"temperature":true}' },
      { name: "negative temperature", json: '{"temperature":-1}' },
      { name: "temperature above the bound", json: '{"temperature":9007199254740992}' },
      { name: "unrounded temperature above the bound", json: '{"temperature":9007199254740991.1}' },
      { name: "null reasoning effort", json: '{"reasoningEffort":null}' },
      { name: "object reasoning effort", json: '{"reasoningEffort":{}}' },
      { name: "numeric reasoning effort", json: '{"reasoningEffort":1}' },
      { name: "empty reasoning effort", json: '{"reasoningEffort":""}' },
      { name: "65-character reasoning effort", json: `{"reasoningEffort":"${"x".repeat(65)}"}` },
      { name: "reasoning effort starting with punctuation", json: '{"reasoningEffort":"-high"}' },
      { name: "reasoning effort with a space", json: '{"reasoningEffort":"high effort"}' },
      { name: "reasoning effort with a newline", json: '{"reasoningEffort":"high\\n"}' },
      { name: "non-ASCII reasoning effort", json: '{"reasoningEffort":"é"}' },
      { name: "null output-token limit", json: '{"maxOutputTokens":null}' },
      { name: "string output-token limit", json: '{"maxOutputTokens":"1"}' },
      { name: "boolean output-token limit", json: '{"maxOutputTokens":true}' },
      { name: "negative output-token limit", json: '{"maxOutputTokens":-1}' },
      { name: "zero output-token limit", json: '{"maxOutputTokens":0}' },
      { name: "fractional output-token limit", json: '{"maxOutputTokens":1.5}' },
      {
        name: "unrounded fractional output-token limit",
        json: '{"maxOutputTokens":1.0000000000000001}',
      },
      { name: "output-token limit above the bound", json: '{"maxOutputTokens":9007199254740992}' },
      { name: "513-byte object", json: `{"temperature": 0.${"0".repeat(493)}1}` },
    ])("rejects $name in the declaration and migrated table", async ({ json }) => {
      expect(await declaredCheck(json)).toEqual([{ valid: false }]);
      const id = await create();
      const before = await database.db.execute(sql`select * from ${table} where id = ${id}`);
      await expect(
        database.db.execute(sql`
          update ${table} set ${sql.identifier(column.name)} = ${json}::jsonb where id = ${id}
        `),
      ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
      expect(
        (await database.db.execute(sql`select * from ${table} where id = ${id}`)).rows,
      ).toEqual(before.rows);
    });

    it("preserves SQL NULL semantics", async () => {
      expect(await declaredCheck(null)).toEqual([{ valid: nullable ? true : null }]);
      if (nullable) {
        const created = await game();
        const [seat] = await database.db
          .insert(gameParticipants)
          .values({
            gameId: created.id,
            color: "white",
            seatType: "human",
            parameters: null,
          })
          .returning();
        expect(seat?.parameters).toBeNull();
      } else {
        const id = await create();
        await expect(
          database.db.execute(sql`
            update ${table} set ${sql.identifier(column.name)} = null where id = ${id}
          `),
        ).rejects.toMatchObject({
          cause: { code: "23502", table: "model_invocations", column: "effective_parameters" },
        });
      }
    });
  });

  it.each([
    {
      name: "missing provider",
      patch: { provider: null },
      constraint: "game_participants_configuration_check",
    },
    {
      name: "missing model ID",
      patch: { modelId: null },
      constraint: "game_participants_configuration_check",
    },
    {
      name: "empty model ID",
      patch: { modelId: "" },
      constraint: "game_participants_model_id_check",
    },
    {
      name: "model ID longer than 256 characters",
      patch: { modelId: "m".repeat(257) },
      constraint: "game_participants_model_id_check",
    },
    {
      name: "model ID containing a newline",
      patch: { modelId: "model\n" },
      constraint: "game_participants_model_id_check",
    },
    {
      name: "SQL NULL parameters",
      patch: { parameters: null },
      constraint: "game_participants_configuration_check",
    },
    {
      name: "human seat retaining AI configuration",
      patch: { seatType: "human" },
      constraint: "game_participants_configuration_check",
    },
  ] as const)("rejects participant with $name", async ({ patch, constraint }) => {
    const { seat } = await aiParticipant();
    await expect(
      database.db.update(gameParticipants).set(patch).where(eq(gameParticipants.id, seat.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
    expect(
      (
        await database.db.select().from(gameParticipants).where(eq(gameParticipants.id, seat.id))
      )[0],
    ).toEqual(seat);
  });

  it("persists typed AI configuration without a human identity", async () => {
    const { seat } = await aiParticipant();
    expect(seat).toMatchObject({
      provider: "google",
      modelId: "models/fixture",
      parameters: { temperature: 0, reasoningEffort: "high", maxOutputTokens: 1000 },
      guestSessionId: null,
      userId: null,
    });
  });

  it("rejects a guest identity on an otherwise valid AI seat", async () => {
    const { created, seat } = await aiParticipant();
    await expect(
      database.db
        .update(gameParticipants)
        .set({ guestSessionId: created.ownerGuestSessionId })
        .where(eq(gameParticipants.id, seat.id)),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "game_participants_identity_check" },
    });
  });

  it("rejects a provider outside the PostgreSQL provider enum", async () => {
    const { seat } = await aiParticipant();
    await expect(
      database.db.execute(
        sql`update game_participants set provider = 'mock' where id = ${seat.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "22P02" } });
  });

  it("rejects a public AI mode on a Sandbox game", async () => {
    const created = await game();
    await database.db.update(games).set({ isSandbox: true }).where(eq(games.id, created.id));
    await expect(
      database.db.update(games).set({ mode: "ai_vs_ai" }).where(eq(games.id, created.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "games_sandbox_mode_check" } });
  });

  it.each([
    {
      name: "reused command ID at a new revision",
      patch: { version: 2, kind: "abort" },
      code: "23505",
      constraint: "game_commands_game_id_command_id_pk",
    },
    {
      name: "reused revision with a new command ID",
      patch: { commandId: randomUUID() },
      code: "23505",
      constraint: "game_commands_version_unique",
    },
    {
      name: "zero revision with a new command ID",
      patch: { version: 0, commandId: randomUUID() },
      code: "23514",
      constraint: "game_commands_version_check",
    },
  ] as const)("rejects receipt with $name", async ({ patch, code, constraint }) => {
    const created = await game();
    const receipt = {
      gameId: created.id,
      commandId: randomUUID(),
      kind: "pause" as const,
      version: 1,
    };
    await database.db.insert(gameCommands).values(receipt);
    await expect(
      database.db.insert(gameCommands).values({ ...receipt, ...patch }),
    ).rejects.toMatchObject({ cause: { code, constraint } });
  });

  it("scopes receipt identity to each game and cascades only the deleted game's receipts", async () => {
    const created = await game();
    const other = await game();
    const receipt = {
      gameId: created.id,
      commandId: randomUUID(),
      kind: "pause" as const,
      version: 1,
    };
    await database.db.insert(gameCommands).values(receipt);
    await database.db.insert(gameCommands).values({ ...receipt, gameId: other.id });
    await database.db.delete(games).where(eq(games.id, created.id));
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, created.id))).toBe(0);
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, other.id))).toBe(1);
  });

  it("reapplies migrations without changing persisted data and replaces the unfinished-owner index with a scoped index", async () => {
    const created = await game();
    await runMigrations(database);
    await runMigrations(database);
    expect((await database.db.select().from(games).where(eq(games.id, created.id)))[0]).toEqual(
      created,
    );
    const result = await database.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where schemaname = 'public' and indexname in ('games_one_unfinished_per_guest', 'games_one_unfinished_per_guest_scope')
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.indexdef).toContain("UNIQUE INDEX");
    expect(result.rows[0]!.indexdef).toContain("games_one_unfinished_per_guest_scope");
    expect(result.rows[0]!.indexdef).toContain("(owner_guest_session_id, is_sandbox)");
    expect(result.rows[0]!.indexdef).toContain("active");
    expect(result.rows[0]!.indexdef).toContain("paused");
  });

  it.each([false, true])(
    "enforces the active/paused slot for isSandbox=%s even for direct racing inserts",
    async (isSandbox) => {
      const owner = await guest();
      const second = integrationDatabase();
      try {
        const results = await Promise.allSettled([
          database.db.insert(games).values({ ...gameValues(owner.id), isSandbox }),
          second.db.insert(games).values({ ...gameValues(owner.id), state: "paused", isSandbox }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(results.find((result) => result.status === "rejected")).toMatchObject({
          reason: { cause: { code: "23505", constraint: "games_one_unfinished_per_guest_scope" } },
        });
        expect(await database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(1);
      } finally {
        await second.close();
      }
    },
  );

  it("allows independent ordinary and Sandbox slots during direct racing inserts", async () => {
    const owner = await guest();
    const second = integrationDatabase();
    try {
      await Promise.all([
        database.db.insert(games).values(gameValues(owner.id)),
        second.db
          .insert(games)
          .values({ ...gameValues(owner.id), state: "paused", isSandbox: true }),
      ]);
      expect(await database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(2);
    } finally {
      await second.close();
    }
  });

  it("frees the slot on both completion and abortion and defaults ordinary games to no sandbox authority", async () => {
    const first = await game();
    expect(first.isSandbox).toBe(false);
    await database.db
      .update(games)
      .set({ state: "completed", result: "0-1", terminationReason: "checkmate" })
      .where(eq(games.id, first.id));
    const [second] = await database.db
      .insert(games)
      .values(gameValues(first.ownerGuestSessionId))
      .returning();
    await database.db
      .update(games)
      .set({ state: "aborted", result: "*", terminationReason: "aborted" })
      .where(eq(games.id, second!.id));
    await expect(
      database.db.insert(games).values(gameValues(first.ownerGuestSessionId)),
    ).resolves.toBeDefined();
  });

  it.each([
    {
      name: "active game with result",
      lifecycle: { state: "active", result: "1-0", terminationReason: "checkmate" },
    },
    {
      name: "decisive completion without reason",
      lifecycle: { state: "completed", result: "1-0", terminationReason: null },
    },
    {
      name: "draw completion without reason",
      lifecycle: { state: "completed", result: "1/2-1/2", terminationReason: null },
    },
    {
      name: "completed game without result",
      lifecycle: { state: "completed", result: "*", terminationReason: "checkmate" },
    },
    {
      name: "decisive stalemate",
      lifecycle: { state: "completed", result: "1-0", terminationReason: "stalemate" },
    },
    {
      name: "aborted game without reason",
      lifecycle: { state: "aborted", result: "*", terminationReason: null },
    },
    {
      name: "aborted game with winner",
      lifecycle: { state: "aborted", result: "0-1", terminationReason: "aborted" },
    },
  ] as const)("rejects contradictory lifecycle: $name", async ({ lifecycle }) => {
    const created = await game();
    await expect(
      database.db.update(games).set(lifecycle).where(eq(games.id, created.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "games_lifecycle_check" } });
  });

  it.each([
    {
      name: "occupied color with no duplicate guest identity",
      patch: { guestSessionId: null },
      code: "23505",
      constraint: "game_participants_color_unique",
    },
    {
      name: "guest assigned to the other color",
      patch: { color: "black" },
      code: "23505",
      constraint: "game_participants_guest_unique",
    },
    {
      name: "missing guest in the unoccupied color",
      patch: { color: "black", guestSessionId: randomUUID() },
      code: "23503",
      constraint: "game_participants_guest_session_id_guest_sessions_id_fk",
    },
    {
      name: "missing game",
      patch: { gameId: randomUUID() },
      code: "23503",
      constraint: "game_participants_game_id_games_id_fk",
    },
  ] as const)("rejects human participant with $name", async ({ patch, code, constraint }) => {
    const created = await game();
    const white = {
      gameId: created.id,
      guestSessionId: created.ownerGuestSessionId,
      color: "white" as const,
      seatType: "human" as const,
    };
    await database.db.insert(gameParticipants).values(white);
    await expect(
      database.db.insert(gameParticipants).values({ ...white, ...patch }),
    ).rejects.toMatchObject({ cause: { code, constraint } });
  });

  it("requires a game's guest owner to exist", async () => {
    const created = await game();
    await expect(
      database.db
        .update(games)
        .set({ ownerGuestSessionId: randomUUID() })
        .where(eq(games.id, created.id)),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "games_owner_guest_session_id_guest_sessions_id_fk" },
    });
  });

  it("requires a move's game to exist", async () => {
    const created = await game();
    await database.db.insert(moves).values(moveValues(created.id));
    await expect(
      database.db.update(moves).set({ gameId: randomUUID() }).where(eq(moves.gameId, created.id)),
    ).rejects.toMatchObject({ cause: { code: "23503", constraint: "moves_game_id_games_id_fk" } });
  });

  it.each([
    {
      name: "duplicate ply with a new command and revision",
      patch: { commandId: randomUUID(), version: 2 },
      constraint: "moves_ply_unique",
    },
    {
      name: "duplicate command with a new ply and revision",
      patch: { ply: 2, version: 2 },
      constraint: "moves_command_unique",
    },
    {
      name: "duplicate revision with a new command and ply",
      patch: { commandId: randomUUID(), ply: 2 },
      constraint: "moves_version_unique",
    },
  ])("rejects move with $name", async ({ patch, constraint }) => {
    const created = await game();
    const accepted = moveValues(created.id);
    await database.db.insert(moves).values(accepted);
    await expect(database.db.insert(moves).values({ ...accepted, ...patch })).rejects.toMatchObject(
      { cause: { code: "23505", constraint } },
    );
  });

  it("allows the same move ply, command and revision in another game", async () => {
    const created = await game();
    const accepted = moveValues(created.id);
    await database.db.insert(moves).values(accepted);
    const other = await game();
    // Deduplication IDs are scoped to the aggregate, not to all games.
    await expect(
      database.db.insert(moves).values({ ...accepted, gameId: other.id }),
    ).resolves.toBeDefined();
  });

  it.each([
    { name: "zero ply", patch: { ply: 0 }, constraint: "moves_ply_check" },
    { name: "zero revision", patch: { version: 0 }, constraint: "moves_version_check" },
    { name: "negative revision", patch: { version: -1 }, constraint: "moves_version_check" },
    {
      name: "revision above the safe-integer bound",
      patch: { version: Number.MAX_SAFE_INTEGER + 1 },
      constraint: "moves_version_check",
    },
    { name: "SAN instead of UCI", patch: { uci: "e4" }, constraint: "moves_uci_check" },
    {
      name: "identical source and destination squares",
      patch: { uci: "e2e2" },
      constraint: "moves_uci_check",
    },
  ])("rejects move with $name", async ({ patch, constraint }) => {
    const created = await game();
    await database.db.insert(moves).values(moveValues(created.id));
    await expect(
      database.db.update(moves).set(patch).where(eq(moves.gameId, created.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
  });

  it.each([
    { name: "negative revision", version: -1 },
    { name: "revision above the safe-integer bound", version: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects game with $name", async ({ version }) => {
    const created = await game();
    await expect(
      database.db.update(games).set({ version }).where(eq(games.id, created.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "games_version_check" } });
  });

  it("accepts the maximum safe-integer game revision", async () => {
    const created = await game();
    await expect(
      database.db
        .update(games)
        .set({ version: Number.MAX_SAFE_INTEGER })
        .where(eq(games.id, created.id)),
    ).resolves.toBeDefined();
  });

  it("rolls back creation if a participant insertion fails", async () => {
    const owner = await guest();
    const values = gameValues(owner.id);
    const repository = createGameRepository(database);
    await expect(
      repository.write(async (tx) => {
        await tx.lockGuest(owner.id);
        await tx.insertGame(values, [
          { gameId: values.id!, color: "white", seatType: "human", guestSessionId: owner.id },
          { gameId: values.id!, color: "white", seatType: "human", guestSessionId: null },
        ]);
      }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "game_participants_color_unique" },
    });
    expect(await database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(0);
  });

  it("cascades only the deleted game's participants and moves", async () => {
    const created = await game();
    const other = await game();
    for (const row of [created, other]) {
      await database.db.insert(gameParticipants).values({
        gameId: row.id,
        color: "white",
        seatType: "human",
        guestSessionId: row.ownerGuestSessionId,
      });
      await database.db.insert(moves).values(moveValues(row.id));
    }
    await database.db.delete(games).where(eq(games.id, created.id));
    expect(await database.db.$count(moves, eq(moves.gameId, created.id))).toBe(0);
    expect(
      await database.db.$count(gameParticipants, eq(gameParticipants.gameId, created.id)),
    ).toBe(0);
    expect(await database.db.$count(moves, eq(moves.gameId, other.id))).toBe(1);
    expect(
      await database.db.$count(
        guestSessions,
        and(eq(guestSessions.id, created.ownerGuestSessionId)),
      ),
    ).toBe(1);
  });
});
