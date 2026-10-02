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

describe("reviewed PostgreSQL migration and structural constraints", () => {
  it("bounds AI budgets and normalized attempts, enforces dispatch uniqueness, and cascades private records", async () => {
    const created = await game();
    const [turn] = await database.db
      .insert(aiTurns)
      .values({ gameId: created.id, ply: 1, color: "white", attemptCount: 1 })
      .returning();
    const invocation = {
      turnId: turn!.id,
      attemptNumber: 1,
      reservationId: randomUUID(),
      commandId: randomUUID(),
      expectedVersion: 0,
      provider: "openai" as const,
      modelId: "fixture",
      effectiveParameters: { temperature: 0 },
    };
    const [attempt] = await database.db.insert(modelInvocations).values(invocation).returning();
    for (const patch of [
      { invalidOutputCount: -1 },
      { invalidOutputCount: 4 },
      { invalidOutputCount: 2 },
      { attemptCount: -1 },
      { acceptedMovePly: 2 },
      { color: "black" as const },
    ]) {
      await expect(
        database.db.update(aiTurns).set(patch).where(eq(aiTurns.id, turn!.id)),
      ).rejects.toThrow();
    }
    await expect(
      database.db.insert(aiTurns).values({ gameId: created.id, ply: 1, color: "white" }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(modelInvocations).values({ ...invocation, reservationId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(modelInvocations).values({ ...invocation, attemptNumber: 2 }),
    ).rejects.toThrow();
    await expect(
      database.db.update(aiTurns).set({ acceptedMovePly: 1 }).where(eq(aiTurns.id, turn!.id)),
    ).rejects.toThrow();
    for (const patch of [
      { durationMs: -1 },
      { expectedVersion: -1 },
      { attemptNumber: 0 },
      { inputTokens: 0 },
      { usageReported: true, inputTokens: -1 },
      { usageReported: true, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
      { outcome: "provider_error" as const, durationMs: 1 },
      { outcome: "discarded" as const, durationMs: 1, errorReason: "network" as const },
      { outcome: "model_invalid" as const, durationMs: 1, errorCode: "provider_auth" as const },
      {
        outcome: "provider_error" as const,
        durationMs: 1,
        errorCode: "provider_auth" as const,
        commentary: "unaccepted",
      },
      { outcome: "accepted" as const, durationMs: 1, commentary: "x".repeat(2001) },
      { modelId: "model?key=secret" },
    ]) {
      await expect(
        database.db.update(modelInvocations).set(patch).where(eq(modelInvocations.id, attempt!.id)),
      ).rejects.toThrow();
    }
    for (const parameters of [
      { apiKey: "secret" },
      [],
      { temperature: "0" },
      { reasoningEffort: null },
      { maxOutputTokens: 1.5 },
    ]) {
      await expect(
        database.db.execute(
          sql`update model_invocations set effective_parameters = ${JSON.stringify(parameters)}::jsonb where id = ${attempt!.id}`,
        ),
      ).rejects.toThrow();
    }
    await database.db.delete(games).where(eq(games.id, created.id));
    expect(await database.db.$count(aiTurns, eq(aiTurns.gameId, created.id))).toBe(0);
    expect(await database.db.$count(modelInvocations, eq(modelInvocations.turnId, turn!.id))).toBe(
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

  it("enforces one bounded reservation per game, separate from accepted receipts, and cascades deletion", async () => {
    const created = await game();
    const reservation = {
      gameId: created.id,
      reservationId: randomUUID(),
      commandId: randomUUID(),
      expectedVersion: 0,
    };
    await database.db.insert(aiTurnReservations).values(reservation);
    expect(await database.db.$count(gameCommands, eq(gameCommands.gameId, created.id))).toBe(0);
    await expect(
      database.db
        .insert(aiTurnReservations)
        .values({ ...reservation, reservationId: randomUUID(), commandId: randomUUID() }),
    ).rejects.toThrow();
    for (const expectedVersion of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        database.db
          .update(aiTurnReservations)
          .set({ expectedVersion })
          .where(eq(aiTurnReservations.gameId, created.id)),
      ).rejects.toThrow();
    }
    await expect(
      database.db.execute(
        sql`update ai_turn_reservations set state = 'accepted' where game_id = ${created.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      database.db.insert(aiTurnReservations).values({ ...reservation, gameId: randomUUID() }),
    ).rejects.toThrow();
    await database.db.delete(games).where(eq(games.id, created.id));
    expect(
      await database.db.$count(aiTurnReservations, eq(aiTurnReservations.gameId, created.id)),
    ).toBe(0);
  });

  it("enforces typed AI selection, bounded parameter metadata and credential-free human seats in PostgreSQL", async () => {
    const created = await game();
    const seat = {
      gameId: created.id,
      color: "white" as const,
      seatType: "ai" as const,
      provider: "google" as const,
      modelId: "models/fixture",
      parameters: { temperature: 0, reasoningEffort: "high", maxOutputTokens: 1000 },
    };
    await database.db.insert(gameParticipants).values(seat);
    const [stored] = await database.db
      .select()
      .from(gameParticipants)
      .where(eq(gameParticipants.gameId, created.id));
    expect(stored).toMatchObject({ ...seat, guestSessionId: null });
    for (const parameters of [
      null,
      [],
      { apiKey: "sentinel" },
      { temperature: "1" },
      { temperature: null },
      { temperature: -1 },
      { reasoningEffort: {} },
      { reasoningEffort: "" },
      { reasoningEffort: "x".repeat(65) },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 1.5 },
      { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { nested: { key: "sentinel" } },
    ]) {
      await expect(
        database.db.execute(
          sql`update game_participants set parameters = ${JSON.stringify(parameters)}::jsonb where id = ${stored!.id}`,
        ),
      ).rejects.toThrow();
    }
    for (const patch of [
      { provider: null },
      { modelId: null },
      { modelId: "" },
      { modelId: "m".repeat(257) },
      { modelId: "model\n" },
      { parameters: null },
      { guestSessionId: created.ownerGuestSessionId },
      { seatType: "human" as const },
    ]) {
      await expect(
        database.db.update(gameParticipants).set(patch).where(eq(gameParticipants.id, stored!.id)),
      ).rejects.toThrow();
    }
    await expect(
      database.db.execute(
        sql`update game_participants set provider = 'mock' where id = ${stored!.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      database.db
        .update(games)
        .set({ mode: "ai_vs_ai", isSandbox: true })
        .where(eq(games.id, created.id)),
    ).rejects.toThrow();
    expect(
      (
        await database.db.select().from(gameParticipants).where(eq(gameParticipants.id, stored!.id))
      )[0],
    ).toEqual(stored);
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

  it("enforces receipt identity/version uniqueness and cascades receipts only with their game", async () => {
    const created = await game();
    const other = await game();
    const receipt = {
      gameId: created.id,
      commandId: randomUUID(),
      kind: "pause" as const,
      version: 1,
    };
    await database.db.insert(gameCommands).values(receipt);
    for (const duplicate of [
      { ...receipt, version: 2, kind: "abort" as const },
      { ...receipt, commandId: randomUUID() },
    ]) {
      await expect(database.db.insert(gameCommands).values(duplicate)).rejects.toThrow();
    }
    await expect(
      database.db.insert(gameCommands).values({ ...receipt, version: 0, commandId: randomUUID() }),
    ).rejects.toThrow();
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
    const owner = await guest();
    await expect(
      database.db.insert(games).values({ ...gameValues(owner.id), ...lifecycle }),
    ).rejects.toThrow();
  });

  it("enforces foreign keys, exclusive colors and a single assigned seat per guest", async () => {
    const created = await game();
    const white = {
      gameId: created.id,
      guestSessionId: created.ownerGuestSessionId,
      color: "white" as const,
      seatType: "human" as const,
    };
    await database.db.insert(gameParticipants).values(white);
    await expect(
      database.db.insert(gameParticipants).values({ ...white, guestSessionId: null }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({ ...white, color: "black" }),
    ).rejects.toThrow();
    await expect(
      database.db
        .insert(gameParticipants)
        .values({ ...white, color: "black", guestSessionId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({ ...white, gameId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(gameParticipants).values({ ...white, color: "black", seatType: "ai" }),
    ).rejects.toThrow();
    await expect(database.db.insert(games).values(gameValues(randomUUID()))).rejects.toThrow();
    await expect(database.db.insert(moves).values(moveValues(randomUUID()))).rejects.toThrow();
  });

  it("enforces per-game move ply, command and aggregate-version uniqueness", async () => {
    const created = await game();
    const accepted = moveValues(created.id);
    await database.db.insert(moves).values(accepted);
    for (const duplicate of [
      { ...accepted, commandId: randomUUID(), version: 2 },
      { ...accepted, ply: 2, version: 2 },
      { ...accepted, commandId: randomUUID(), ply: 2 },
    ]) {
      await expect(database.db.insert(moves).values(duplicate)).rejects.toThrow();
    }
    const other = await game();
    // Deduplication IDs are scoped to the aggregate, not to all games.
    await expect(
      database.db.insert(moves).values({ ...accepted, gameId: other.id }),
    ).resolves.toBeDefined();
  });

  it("rejects invalid counters and malformed UCI while keeping safe-integer revisions", async () => {
    const created = await game();
    for (const patch of [
      { ply: 0 },
      { version: 0 },
      { version: -1 },
      { version: Number.MAX_SAFE_INTEGER + 1 },
      { uci: "e4" },
      { uci: "e2e2" },
    ]) {
      await expect(
        database.db.insert(moves).values({ ...moveValues(created.id), ...patch }),
      ).rejects.toThrow();
    }
    for (const version of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        database.db.update(games).set({ version }).where(eq(games.id, created.id)),
      ).rejects.toThrow();
    }
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
    ).rejects.toThrow();
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
