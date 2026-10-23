import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";

import type { DatabaseConnection } from "../src/index.js";

export const historicalMigrations = [
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
] as const;

export type HistoricalMigration = (typeof historicalMigrations)[number];
export type MigrationTransaction = Parameters<
  Parameters<DatabaseConnection["db"]["transaction"]>[0]
>[0];

export interface MigrationFixture {
  tx: MigrationTransaction;
  schemaName: string;
  applyMigration: (name: HistoricalMigration) => Promise<void>;
}

export async function withMigrationSchema(
  database: DatabaseConnection,
  scenario: (fixture: MigrationFixture) => Promise<void>,
): Promise<void> {
  // Creating the schema in this transaction also cleans it up on SQL/assertion failure.
  await database.db.transaction(async (tx) => {
    const schemaName = "migration_" + randomUUID().replaceAll("-", "");
    await tx.execute(sql`create schema ${sql.identifier(schemaName)}`);
    await tx.execute(sql`set local search_path to ${sql.identifier(schemaName)}`);
    await scenario({
      tx,
      schemaName,
      async applyMigration(name) {
        const source = await readFile(new URL(`../drizzle/${name}.sql`, import.meta.url), "utf8");
        for (const statement of source
          .split("--> statement-breakpoint")
          .filter((part) => part.trim())) {
          await tx.execute(sql.raw(statement.replaceAll('"public"', '"' + schemaName + '"')));
        }
      },
    });
    await tx.execute(sql`drop schema ${sql.identifier(schemaName)} cascade`);
  });
}

export async function snapshotTables(
  tx: MigrationTransaction,
  tables: readonly string[],
  omittedColumns: Record<string, string[]> = {},
) {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of tables) {
    const omitted = sql.param(omittedColumns[table] ?? []);
    snapshot[table] = (
      await tx.execute(sql`
        select to_jsonb(t) - ${omitted}::text[] as value from ${sql.identifier(table)} t
        order by (to_jsonb(t) - ${omitted}::text[])::text`)
    ).rows;
  }
  return snapshot;
}
