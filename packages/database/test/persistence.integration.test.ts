import { createCipheriv, createDecipheriv, createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, eq, inArray, sql } from "drizzle-orm";
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

  it.each([
    { name: "credential field", parameters: { apiKey: "secret" } },
    { name: "array instead of an object", parameters: [] },
    { name: "string temperature", parameters: { temperature: "0" } },
    { name: "null reasoning effort", parameters: { reasoningEffort: null } },
    { name: "fractional output-token limit", parameters: { maxOutputTokens: 1.5 } },
  ])("rejects invocation parameters with $name", async ({ parameters }) => {
    const { attempt } = await invocation();
    await expect(
      database.db.execute(
        sql`update model_invocations set effective_parameters = ${JSON.stringify(parameters)}::jsonb where id = ${attempt.id}`,
      ),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "model_invocations_parameters_check" },
    });
  });

  it("cascades private AI turns and invocations when their game is deleted", async () => {
    const { turn } = await invocation();
    await database.db.delete(games).where(eq(games.id, turn.gameId));
    expect(await database.db.$count(aiTurns, eq(aiTurns.gameId, turn.gameId))).toBe(0);
    expect(await database.db.$count(modelInvocations, eq(modelInvocations.turnId, turn.id))).toBe(
      0,
    );
  });

  it("migrates populated legacy games without inventing AI configuration or changing Sandbox authority", async () => {
    const schemaName = "migration_" + randomUUID().replaceAll("-", "");
    const migrationFiles = await Promise.all(
      [
        "0001_guest_owned_games",
        "0002_game_command_receipts",
        "0003_ai_game_configuration",
        "0004_ai_turn_reservations",
        "0005_ai_invocation_policy",
        "0006_ai_controller_presence",
        "0007_separate_sandbox_game_slot",
        "0008_better_auth_foundation",
        "0009_oauth_account_identity",
        "0010_account_owned_games",
        "0011_profiles",
        "0012_provider_credentials",
        "0013_owner_scoped_credential_ids",
        "0014_account_history_index",
        "0015_private_room_foundation",
        "0016_participant_game_slots",
        "0017_backfill_participant_game_slots",
        "0018_shared_room_history",
      ].map((name) => readFile(new URL(`../drizzle/${name}.sql`, import.meta.url), "utf8")),
    );
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`create schema ${sql.identifier(schemaName)}`);
      await tx.execute(sql`set local search_path to ${sql.identifier(schemaName)}`);
      async function applyMigration(contents: string) {
        for (const statement of contents
          .split("--> statement-breakpoint")
          .filter((part) => part.trim())) {
          await tx.execute(sql.raw(statement.replaceAll('"public"', '"' + schemaName + '"')));
        }
      }
      await applyMigration(migrationFiles[0]!);
      for (const state of ["active", "paused", "completed", "aborted"] as const) {
        const ownerId = randomUUID();
        const gameId = randomUUID();
        const result = state === "completed" ? "1-0" : "*";
        const reason =
          state === "completed" ? "human_resignation" : state === "aborted" ? "aborted" : null;
        await tx.execute(
          sql`insert into guest_sessions(id, token_hash, expires_at) values (${ownerId}, ${ownerId.replaceAll("-", "").repeat(2)}, clock_timestamp() + interval '1 hour')`,
        );
        await tx.execute(
          sql`insert into games(id, owner_guest_session_id, is_sandbox, state, result, termination_reason, fen, pgn, version) values (${gameId}, ${ownerId}, true, ${state}, ${result}, ${reason}, 'accepted-position', 'accepted-history', 1)`,
        );
        await tx.execute(
          sql`insert into game_participants(game_id, color, seat_type, guest_session_id) values (${gameId}, 'white', 'human', ${ownerId}), (${gameId}, 'black', 'human', null)`,
        );
        await tx.execute(
          sql`insert into moves(game_id, ply, uci, san, fen, command_id, version) values (${gameId}, 1, 'e2e4', 'e4', 'accepted-position', ${randomUUID()}, 1)`,
        );
      }
      // Legacy ordinary-human fixtures must not acquire the Sandbox exception either.
      await tx.execute(sql`update games set is_sandbox = false where state = 'aborted'`);
      await applyMigration(migrationFiles[1]!);
      const beforeGames = await tx.execute(
        sql`select to_jsonb(games) as value from games order by id`,
      );
      const beforeSeats = await tx.execute(
        sql`select to_jsonb(game_participants) as value from game_participants order by id`,
      );
      const beforeMoves = await tx.execute(sql`select * from moves order by id`);
      const beforeCommands = await tx.execute(sql`select * from game_commands order by game_id`);
      await applyMigration(migrationFiles[2]!);
      expect(
        (await tx.execute(sql`select to_jsonb(games) - 'mode' as value from games order by id`))
          .rows,
      ).toEqual(beforeGames.rows);
      expect(
        (
          await tx.execute(
            sql`select to_jsonb(game_participants) - array['provider', 'model_id', 'parameters'] as value from game_participants order by id`,
          )
        ).rows,
      ).toEqual(beforeSeats.rows);
      expect((await tx.execute(sql`select * from moves order by id`)).rows).toEqual(
        beforeMoves.rows,
      );
      expect((await tx.execute(sql`select * from game_commands order by game_id`)).rows).toEqual(
        beforeCommands.rows,
      );
      expect(
        (await tx.execute(sql`select count(*)::int as count from games where mode is not null`))
          .rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await tx.execute(
            sql`select count(*)::int as count from game_participants where provider is not null or model_id is not null or parameters is not null`,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      const aiOwner = randomUUID();
      const aiGame = randomUUID();
      await tx.execute(
        sql`insert into guest_sessions(id, token_hash, expires_at) values (${aiOwner}, ${aiOwner.replaceAll("-", "").repeat(2)}, clock_timestamp() + interval '1 hour')`,
      );
      await tx.execute(
        sql`insert into games(id, owner_guest_session_id, mode, state, result, fen, pgn, version) values (${aiGame}, ${aiOwner}, 'ai_vs_ai', 'active', '*', 'ai-position', 'ai-history', 0)`,
      );
      await tx.execute(
        sql`insert into game_participants(game_id, color, seat_type, provider, model_id, parameters) values (${aiGame}, 'white', 'ai', 'openai', 'fixture-white', '{}'), (${aiGame}, 'black', 'ai', 'anthropic', 'fixture-black', '{}')`,
      );
      const beforeReservations = [
        await tx.execute(sql`select * from games order by id`),
        await tx.execute(sql`select * from game_participants order by id`),
        await tx.execute(sql`select * from moves order by id`),
        await tx.execute(sql`select * from game_commands order by game_id`),
      ];
      await applyMigration(migrationFiles[3]!);
      const afterReservations = [
        await tx.execute(sql`select * from games order by id`),
        await tx.execute(sql`select * from game_participants order by id`),
        await tx.execute(sql`select * from moves order by id`),
        await tx.execute(sql`select * from game_commands order by game_id`),
      ];
      expect(afterReservations.map((result) => result.rows)).toEqual(
        beforeReservations.map((result) => result.rows),
      );
      expect((await tx.execute(sql`select * from ai_turn_reservations`)).rows).toEqual([]);
      await tx.execute(
        sql`insert into ai_turn_reservations(game_id, reservation_id, command_id, expected_version) values (${aiGame}, ${randomUUID()}, ${randomUUID()}, 0)`,
      );
      const reservationRows = await tx.execute(sql`select * from ai_turn_reservations`);
      await applyMigration(migrationFiles[4]!);
      expect((await tx.execute(sql`select * from ai_turn_reservations`)).rows).toEqual(
        reservationRows.rows,
      );
      expect((await tx.execute(sql`select * from ai_turns`)).rows).toEqual([]);
      expect((await tx.execute(sql`select * from model_invocations`)).rows).toEqual([]);
      await applyMigration(migrationFiles[5]!);
      await tx.execute(
        sql`insert into ai_controllers(game_id, controller_id, expires_at) values (${aiGame}, ${randomUUID()}, clock_timestamp() + interval '1 minute')`,
      );
      const controllers = await tx.execute(sql`select * from ai_controllers`);
      await applyMigration(migrationFiles[6]!);
      const beforeGuests = await tx.execute(sql`select * from guest_sessions order by id`);
      await applyMigration(migrationFiles[7]!);
      expect((await tx.execute(sql`select * from guest_sessions order by id`)).rows).toEqual(
        beforeGuests.rows,
      );
      for (const table of ["user", "account", "session", "verification", "rate_limit"]) {
        expect((await tx.execute(sql`select * from ${sql.identifier(table)}`)).rows).toEqual([]);
      }
      const authUserId = randomUUID();
      await tx.execute(
        sql`insert into "user" (id, name, email, email_verified) values (${authUserId}, '', 'upgrade@example.com', true)`,
      );
      await tx.execute(
        sql`insert into account (account_id, provider_id, user_id, password, updated_at) values (${authUserId}, 'credential', ${authUserId}, 'upgrade-password-hash', now())`,
      );
      await tx.execute(
        sql`insert into session (token, user_id, expires_at, updated_at) values ('upgrade-session-fixture', ${authUserId}, now() + interval '1 day', now())`,
      );
      await tx.execute(
        sql`insert into verification (identifier, value, expires_at) values ('upgrade-verification-fixture', ${authUserId}, now() + interval '1 hour')`,
      );
      const authTables = ["user", "account", "session", "verification", "rate_limit"];
      async function authSnapshot() {
        const result = [];
        for (const table of authTables) {
          result.push(
            (await tx.execute(sql`select * from ${sql.identifier(table)} order by id`)).rows,
          );
        }
        return result;
      }
      const beforeAuth = await authSnapshot();
      await applyMigration(migrationFiles[8]!);
      expect(await authSnapshot()).toEqual(beforeAuth);
      expect((await tx.execute(sql`select * from ai_controllers`)).rows).toEqual(controllers.rows);
      expect((await tx.execute(sql`select * from ai_turn_reservations`)).rows).toEqual(
        reservationRows.rows,
      );
      expect((await tx.execute(sql`select * from games order by id`)).rows).toEqual(
        afterReservations[0]!.rows,
      );
      expect((await tx.execute(sql`select * from game_participants order by id`)).rows).toEqual(
        afterReservations[1]!.rows,
      );
      expect((await tx.execute(sql`select * from moves order by id`)).rows).toEqual(
        afterReservations[2]!.rows,
      );
      expect((await tx.execute(sql`select * from game_commands order by game_id`)).rows).toEqual(
        afterReservations[3]!.rows,
      );
      const turnId = randomUUID();
      await tx.execute(
        sql`insert into ai_turns(id, game_id, ply, color, attempt_count) values (${turnId}, ${aiGame}, 1, 'white', 1)`,
      );
      await tx.execute(
        sql`insert into model_invocations(turn_id, attempt_number, reservation_id, command_id, expected_version, provider, model_id, effective_parameters) values (${turnId}, 1, ${randomUUID()}, ${randomUUID()}, 0, 'openai', 'fixture-white', '{}')`,
      );
      const preservedTables = [
        "guest_sessions",
        "games",
        "game_participants",
        "moves",
        "game_commands",
        "ai_turn_reservations",
        "ai_controllers",
        "ai_turns",
        "model_invocations",
      ];
      const beforeOwnership = [];
      for (const table of preservedTables) {
        beforeOwnership.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      await applyMigration(migrationFiles[9]!);
      expect(await authSnapshot()).toEqual(beforeAuth);
      for (const [index, table] of preservedTables.entries()) {
        const added =
          table === "games"
            ? "{owner_user_id}"
            : table === "game_participants"
              ? "{user_id}"
              : "{}";
        const after = await tx.execute(
          sql`select to_jsonb(t) - ${added}::text[] as value from ${sql.identifier(table)} t order by (to_jsonb(t) - ${added}::text[])::text`,
        );
        expect(after.rows, table).toEqual(beforeOwnership[index]);
      }
      const accountGameId = randomUUID();
      await tx.execute(
        sql`insert into games(id, owner_user_id, mode, state, result, fen, pgn) values (${accountGameId}, ${authUserId}, 'ai_vs_human', 'paused', '*', 'account-position', 'account-history')`,
      );
      await tx.execute(
        sql`insert into game_participants(game_id, color, seat_type, user_id) values (${accountGameId}, 'white', 'human', ${authUserId})`,
      );
      await tx.execute(
        sql`update "user" set image = 'https://lh3.googleusercontent.com/a/upgrade' where id = ${authUserId}`,
      );
      const beforeProfiles = [];
      for (const table of [...authTables, ...preservedTables]) {
        beforeProfiles.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      await applyMigration(migrationFiles[10]!);
      const afterProfiles = [];
      for (const table of [...authTables, ...preservedTables]) {
        afterProfiles.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      expect(afterProfiles).toEqual(beforeProfiles);
      expect((await tx.execute(sql`select * from profiles`)).rows).toEqual([]);
      await tx.execute(
        sql`insert into profiles(user_id, username, username_normalized) values (${authUserId}, 'Upgraded', 'upgraded')`,
      );
      const credentialPreservedTables = [...authTables, ...preservedTables, "profiles"];
      const beforeCredentials = [];
      for (const table of credentialPreservedTables) {
        beforeCredentials.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      await applyMigration(migrationFiles[11]!);
      const afterCredentials = [];
      for (const table of credentialPreservedTables) {
        afterCredentials.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      expect(afterCredentials).toEqual(beforeCredentials);
      expect((await tx.execute(sql`select * from provider_credentials`)).rows).toEqual([]);
      const sharedCredentialId = randomUUID();
      const fixtureKey = Buffer.alloc(32, 9);
      const fixtureNonce = Buffer.from("0123456789abcdef01234567", "hex");
      const fixtureAad = Buffer.from(
        JSON.stringify([
          "neurochess-provider-credential",
          1,
          "upgrade-fixture",
          authUserId,
          "openai",
          sharedCredentialId,
        ]),
      );
      const cipher = createCipheriv("aes-256-gcm", fixtureKey, fixtureNonce, { authTagLength: 16 });
      cipher.setAAD(fixtureAad);
      const fixtureCiphertext = Buffer.concat([
        cipher.update("migration-fixture-key-1234", "utf8"),
        cipher.final(),
      ]);
      await tx.execute(sql`
        insert into provider_credentials(id, user_id, provider, label, masked_suffix, version, key_id, nonce, auth_tag, ciphertext)
        values (${sharedCredentialId}, ${authUserId}, 'openai', 'Preserved', '1234', 1, 'upgrade-fixture',
          ${fixtureNonce.toString("hex")}, ${cipher.getAuthTag().toString("hex")}, ${fixtureCiphertext.toString("hex")})`);
      const scopePreservedTables = [...credentialPreservedTables, "provider_credentials"];
      const beforeCredentialScope = [];
      for (const table of scopePreservedTables) {
        beforeCredentialScope.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      await applyMigration(migrationFiles[12]!);
      const afterCredentialScope = [];
      for (const table of scopePreservedTables) {
        afterCredentialScope.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      expect(afterCredentialScope).toEqual(beforeCredentialScope);
      await applyMigration(migrationFiles[13]!);
      const afterHistoryIndex = [];
      for (const table of scopePreservedTables) {
        afterHistoryIndex.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      expect(afterHistoryIndex).toEqual(afterCredentialScope);
      await applyMigration(migrationFiles[14]!);
      const afterRoomFoundation = [];
      for (const table of scopePreservedTables) {
        afterRoomFoundation.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      expect(afterRoomFoundation).toEqual(afterHistoryIndex);
      await applyMigration(migrationFiles[15]!);
      await applyMigration(migrationFiles[16]!);
      await applyMigration(migrationFiles[17]!);
      const slots = await tx.execute<{
        game_id: string;
        scope: string;
        user_id: string | null;
        guest_session_id: string | null;
      }>(sql`select game_id, scope, user_id, guest_session_id from game_slots`);
      expect(slots.rows).toContainEqual({
        game_id: accountGameId,
        scope: "ordinary",
        user_id: authUserId,
        guest_session_id: null,
      });
      expect(slots.rows).toContainEqual({
        game_id: aiGame,
        scope: "ordinary",
        user_id: null,
        guest_session_id: aiOwner,
      });
      expect(slots.rows.filter((slot) => slot.scope === "sandbox")).toHaveLength(2);
      const afterSlots = [];
      for (const table of scopePreservedTables) {
        afterSlots.push(
          (
            await tx.execute(
              sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      }
      expect(afterSlots).toEqual(afterRoomFoundation);
      expect((await tx.execute(sql`select * from rooms`)).rows).toEqual([]);
      expect((await tx.execute(sql`select * from room_creation_operations`)).rows).toEqual([]);
      for (const mode of [null, "ai_vs_ai", "ai_vs_human"]) {
        const ownedGameId = randomUUID();
        await tx.execute(sql`
          insert into games(id, owner_guest_session_id, mode, state, result, termination_reason, fen, pgn)
          values (${ownedGameId}, ${aiOwner}, ${mode}, 'aborted', '*', 'aborted', 'position', 'history')`);
        await expect(
          tx.transaction((savepoint) =>
            savepoint.execute(sql`
              update games set owner_guest_session_id = null where id = ${ownedGameId}`),
          ),
          `solo mode ${mode ?? "legacy"} still requires an owner after the room upgrade`,
        ).rejects.toMatchObject({ cause: { code: "23514", constraint: "games_owner_check" } });
      }
      const modes = await tx.execute<{ enumlabel: string }>(sql`
        select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = ${schemaName} and t.typname = 'ai_game_mode' order by e.enumsortorder`);
      expect(modes.rows.map((row) => row.enumlabel)).toEqual([
        "ai_vs_ai",
        "ai_vs_human",
        "human_vs_human",
      ]);
      const historyIndex = await tx.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes where schemaname = ${schemaName} and indexname = 'games_account_history_idx'`,
      );
      expect(historyIndex.rows[0]?.indexdef).toContain(
        "owner_user_id, updated_at DESC NULLS LAST, id DESC NULLS LAST",
      );
      const stored = (
        await tx.execute<{ nonce: string; auth_tag: string; ciphertext: string }>(sql`
        select nonce, auth_tag, ciphertext from provider_credentials
        where user_id = ${authUserId} and id = ${sharedCredentialId}`)
      ).rows[0]!;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        fixtureKey,
        Buffer.from(stored.nonce, "hex"),
        { authTagLength: 16 },
      );
      decipher.setAAD(fixtureAad);
      decipher.setAuthTag(Buffer.from(stored.auth_tag, "hex"));
      expect(
        Buffer.concat([
          decipher.update(Buffer.from(stored.ciphertext, "hex")),
          decipher.final(),
        ]).toString("utf8"),
      ).toBe("migration-fixture-key-1234");
      const otherCredentialOwner = randomUUID();
      await tx.execute(
        sql`insert into "user" (id, name, email) values (${otherCredentialOwner}, '', 'other-upgrade@example.com')`,
      );
      const otherCredential = await tx.execute(sql`
        insert into provider_credentials(id, user_id, provider, label, version, key_id, nonce, auth_tag, ciphertext)
        select id, ${otherCredentialOwner}, provider, 'Independent', version, key_id, nonce, auth_tag, ciphertext
        from provider_credentials where user_id = ${authUserId} and id = ${sharedCredentialId}
        on conflict (user_id, id) do nothing returning id`);
      expect(otherCredential.rows).toEqual([{ id: sharedCredentialId }]);
      const duplicateCredential = await tx.execute(sql`
        insert into provider_credentials(id, user_id, provider, label, version, key_id, nonce, auth_tag, ciphertext)
        select id, user_id, provider, 'Replacement', version, key_id, nonce, auth_tag, ciphertext
        from provider_credentials where user_id = ${authUserId} and id = ${sharedCredentialId}
        on conflict (user_id, id) do nothing returning id`);
      expect(duplicateCredential.rows).toEqual([]);
      expect(
        (
          await tx.execute(
            sql`select label from provider_credentials where user_id = ${authUserId} and id = ${sharedCredentialId}`,
          )
        ).rows,
      ).toEqual([{ label: "Preserved" }]);
      expect(
        (await tx.execute(sql`select owner_user_id from games where id = ${accountGameId}`)).rows,
      ).toEqual([{ owner_user_id: authUserId }]);
      await tx.execute(sql`drop schema ${sql.identifier(schemaName)} cascade`);
    });
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

  it.each([
    { name: "JSON null instead of an object", parameters: null },
    { name: "array instead of an object", parameters: [] },
    { name: "credential field", parameters: { apiKey: "sentinel" } },
    { name: "string temperature", parameters: { temperature: "1" } },
    { name: "null temperature", parameters: { temperature: null } },
    { name: "negative temperature", parameters: { temperature: -1 } },
    { name: "object reasoning effort", parameters: { reasoningEffort: {} } },
    { name: "empty reasoning effort", parameters: { reasoningEffort: "" } },
    {
      name: "reasoning effort longer than 64 characters",
      parameters: { reasoningEffort: "x".repeat(65) },
    },
    { name: "zero output-token limit", parameters: { maxOutputTokens: 0 } },
    { name: "fractional output-token limit", parameters: { maxOutputTokens: 1.5 } },
    {
      name: "output-token limit above the safe-integer bound",
      parameters: { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    },
    { name: "unknown nested field", parameters: { nested: { key: "sentinel" } } },
  ])("rejects AI seat parameters with $name", async ({ parameters }) => {
    const { seat } = await aiParticipant();
    await expect(
      database.db.execute(
        sql`update game_participants set parameters = ${JSON.stringify(parameters)}::jsonb where id = ${seat.id}`,
      ),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "game_participants_parameters_check" },
    });
    expect(
      (
        await database.db.select().from(gameParticipants).where(eq(gameParticipants.id, seat.id))
      )[0],
    ).toEqual(seat);
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

  it("backfills pre-existing move identities with the actual forward migration", async () => {
    const schemaName = "migration_" + randomUUID().replaceAll("-", "");
    const oldSql = await readFile(
      new URL("../drizzle/0001_guest_owned_games.sql", import.meta.url),
      "utf8",
    );
    const nextSql = await readFile(
      new URL("../drizzle/0002_game_command_receipts.sql", import.meta.url),
      "utf8",
    );
    const ownerId = randomUUID();
    const gameId = randomUUID();
    const commandId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`create schema ${sql.identifier(schemaName)}`);
      await tx.execute(sql`set local search_path to ${sql.identifier(schemaName)}`);
      for (const statement of oldSql
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim())) {
        await tx.execute(sql.raw(statement.replaceAll('"public"', '"' + schemaName + '"')));
      }
      await tx.execute(
        sql`insert into guest_sessions(id, token_hash, expires_at) values (${ownerId}, ${"1".repeat(64)}, clock_timestamp() + interval '1 hour')`,
      );
      await tx.execute(
        sql`insert into games(id, owner_guest_session_id, state, result, fen, pgn, version) values (${gameId}, ${ownerId}, 'active', '*', 'fixture', 'fixture', 1)`,
      );
      await tx.execute(
        sql`insert into moves(game_id, ply, uci, san, fen, command_id, version) values (${gameId}, 1, 'e2e4', 'e4', 'fixture', ${commandId}, 1)`,
      );
      for (const statement of nextSql
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim())) {
        await tx.execute(sql.raw(statement.replaceAll('"public"', '"' + schemaName + '"')));
      }
      const receipts = await tx.execute(
        sql`select game_id, command_id, kind, version from game_commands`,
      );
      expect(receipts.rows).toEqual([
        { game_id: gameId, command_id: commandId, kind: "move", version: "1" },
      ]);
      await tx.execute(sql`drop schema ${sql.identifier(schemaName)} cascade`);
    });
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
