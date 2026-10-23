import { createCipheriv, createDecipheriv, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  type HistoricalMigration,
  historicalMigrations,
  type MigrationFixture,
  type MigrationTransaction,
} from "./migration-fixture.js";

export const gameTables = [
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
export const authTables = ["user", "account", "session", "verification", "rate_limit"];
export const profileTables = [...authTables, ...gameTables, "profiles"];
export const credentialTables = [...profileTables, "provider_credentials"];

export function historicalData(tx: MigrationTransaction) {
  const aiOwner = randomUUID();
  const aiGame = randomUUID();
  const authUserId = randomUUID();
  const accountGameId = randomUUID();
  const credentialId = randomUUID();
  const key = Buffer.alloc(32, 9);
  const nonce = Buffer.from("0123456789abcdef01234567", "hex");
  const aad = Buffer.from(
    JSON.stringify([
      "neurochess-provider-credential",
      1,
      "upgrade-fixture",
      authUserId,
      "openai",
      credentialId,
    ]),
  );

  return {
    aiOwner,
    aiGame,
    authUserId,
    accountGameId,
    credentialId,
    async seedAfterMigration(name: HistoricalMigration) {
      switch (name) {
        case "0001_guest_owned_games":
          for (const state of ["active", "paused", "completed", "aborted"] as const) {
            const ownerId = randomUUID();
            const gameId = randomUUID();
            const result = state === "completed" ? "1-0" : "*";
            const reason =
              state === "completed" ? "human_resignation" : state === "aborted" ? "aborted" : null;
            await tx.execute(sql`
              insert into guest_sessions(id, token_hash, expires_at)
              values (${ownerId}, ${ownerId.replaceAll("-", "").repeat(2)}, clock_timestamp() + interval '1 hour')`);
            await tx.execute(sql`
              insert into games(id, owner_guest_session_id, is_sandbox, state, result, termination_reason, fen, pgn, version)
              values (${gameId}, ${ownerId}, ${state !== "aborted"}, ${state}, ${result}, ${reason}, 'accepted-position', 'accepted-history', 1)`);
            await tx.execute(sql`
              insert into game_participants(game_id, color, seat_type, guest_session_id)
              values (${gameId}, 'white', 'human', ${ownerId}), (${gameId}, 'black', 'human', null)`);
            await tx.execute(sql`
              insert into moves(game_id, ply, uci, san, fen, command_id, version)
              values (${gameId}, 1, 'e2e4', 'e4', 'accepted-position', ${randomUUID()}, 1)`);
          }
          break;
        case "0003_ai_game_configuration":
          await tx.execute(sql`
            insert into guest_sessions(id, token_hash, expires_at)
            values (${aiOwner}, ${aiOwner.replaceAll("-", "").repeat(2)}, clock_timestamp() + interval '1 hour')`);
          await tx.execute(sql`
            insert into games(id, owner_guest_session_id, mode, state, result, fen, pgn, version)
            values (${aiGame}, ${aiOwner}, 'ai_vs_ai', 'active', '*', 'ai-position', 'ai-history', 0)`);
          await tx.execute(sql`
            insert into game_participants(game_id, color, seat_type, provider, model_id, parameters)
            values (${aiGame}, 'white', 'ai', 'openai', 'fixture-white', '{}'),
                   (${aiGame}, 'black', 'ai', 'anthropic', 'fixture-black', '{}')`);
          break;
        case "0004_ai_turn_reservations":
          await tx.execute(sql`
            insert into ai_turn_reservations(game_id, reservation_id, command_id, expected_version)
            values (${aiGame}, ${randomUUID()}, ${randomUUID()}, 0)`);
          break;
        case "0005_ai_invocation_policy": {
          const turnId = randomUUID();
          await tx.execute(sql`
            insert into ai_turns(id, game_id, ply, color, attempt_count)
            values (${turnId}, ${aiGame}, 1, 'white', 1)`);
          await tx.execute(sql`
            insert into model_invocations(turn_id, attempt_number, reservation_id, command_id, expected_version, provider, model_id, effective_parameters)
            values (${turnId}, 1, ${randomUUID()}, ${randomUUID()}, 0, 'openai', 'fixture-white', '{}')`);
          break;
        }
        case "0006_ai_controller_presence":
          await tx.execute(sql`
            insert into ai_controllers(game_id, controller_id, expires_at)
            values (${aiGame}, ${randomUUID()}, clock_timestamp() + interval '1 minute')`);
          break;
        case "0008_better_auth_foundation":
          await tx.execute(sql`
            insert into "user"(id, name, email, email_verified)
            values (${authUserId}, '', 'upgrade@example.com', true)`);
          await tx.execute(sql`
            insert into account(account_id, provider_id, user_id, password, updated_at)
            values (${authUserId}, 'credential', ${authUserId}, 'upgrade-password-hash', now())`);
          await tx.execute(sql`
            insert into session(token, user_id, expires_at, updated_at)
            values ('upgrade-session-fixture', ${authUserId}, now() + interval '1 day', now())`);
          await tx.execute(sql`
            insert into verification(identifier, value, expires_at)
            values ('upgrade-verification-fixture', ${authUserId}, now() + interval '1 hour')`);
          break;
        case "0010_account_owned_games":
          await tx.execute(sql`
            insert into games(id, owner_user_id, mode, state, result, fen, pgn)
            values (${accountGameId}, ${authUserId}, 'ai_vs_human', 'paused', '*', 'account-position', 'account-history')`);
          await tx.execute(sql`
            insert into game_participants(game_id, color, seat_type, user_id)
            values (${accountGameId}, 'white', 'human', ${authUserId})`);
          await tx.execute(
            sql`update "user" set image = 'https://lh3.googleusercontent.com/a/upgrade' where id = ${authUserId}`,
          );
          break;
        case "0011_profiles":
          await tx.execute(sql`
            insert into profiles(user_id, username, username_normalized)
            values (${authUserId}, 'Upgraded', 'upgraded')`);
          break;
        case "0012_provider_credentials": {
          const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
          cipher.setAAD(aad);
          const ciphertext = Buffer.concat([
            cipher.update("migration-fixture-key-1234", "utf8"),
            cipher.final(),
          ]);
          await tx.execute(sql`
            insert into provider_credentials(id, user_id, provider, label, masked_suffix, version, key_id, nonce, auth_tag, ciphertext)
            values (${credentialId}, ${authUserId}, 'openai', 'Preserved', '1234', 1, 'upgrade-fixture',
              ${nonce.toString("hex")}, ${cipher.getAuthTag().toString("hex")}, ${ciphertext.toString("hex")})`);
          break;
        }
      }
    },
    async decryptedCredential() {
      const stored = (
        await tx.execute<{ nonce: string; auth_tag: string; ciphertext: string }>(sql`
        select nonce, auth_tag, ciphertext from provider_credentials
        where user_id = ${authUserId} and id = ${credentialId}`)
      ).rows[0]!;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.nonce, "hex"), {
        authTagLength: 16,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(stored.auth_tag, "hex"));
      return Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "hex")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

export async function populateHistoricalSchema(
  fixture: MigrationFixture,
  through: HistoricalMigration,
) {
  const data = historicalData(fixture.tx);
  for (const name of historicalMigrations) {
    await fixture.applyMigration(name);
    await data.seedAfterMigration(name);
    if (name === through) break;
  }
  return data;
}
