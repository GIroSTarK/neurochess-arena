import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import type { DatabaseConnection } from "../src/index.js";

import {
  authTables,
  credentialTables,
  gameTables,
  populateHistoricalSchema,
} from "./historical-migration-fixture.js";
import { snapshotTables, withMigrationSchema } from "./migration-fixture.js";

let database: DatabaseConnection;
beforeAll(() => {
  database = integrationDatabase();
});
afterAll(async () => {
  await database.close();
});

describe("account migrations", () => {
  it("0008 adds empty auth tables without changing populated guest games or execution", async () => {
    await withMigrationSchema(database, async (fixture) => {
      await populateHistoricalSchema(fixture, "0007_separate_sandbox_game_slot");
      const before = await snapshotTables(fixture.tx, gameTables);
      await fixture.applyMigration("0008_better_auth_foundation");
      expect(await snapshotTables(fixture.tx, gameTables)).toEqual(before);
      for (const table of authTables) {
        expect(
          (await fixture.tx.execute(sql`select * from ${sql.identifier(table)}`)).rows,
          table,
        ).toEqual([]);
      }
    });
  });

  it("0009 preserves populated auth and game records when adding OAuth identity uniqueness", async () => {
    await withMigrationSchema(database, async (fixture) => {
      await populateHistoricalSchema(fixture, "0008_better_auth_foundation");
      const tables = [...authTables, ...gameTables];
      const before = await snapshotTables(fixture.tx, tables);
      await fixture.applyMigration("0009_oauth_account_identity");
      expect(await snapshotTables(fixture.tx, tables)).toEqual(before);
    });
  });

  it("0010 preserves guest owners, seats and execution records without transferring ownership", async () => {
    await withMigrationSchema(database, async (fixture) => {
      await populateHistoricalSchema(fixture, "0009_oauth_account_identity");
      const tables = [...authTables, ...gameTables];
      const before = await snapshotTables(fixture.tx, tables);
      await fixture.applyMigration("0010_account_owned_games");
      expect(
        await snapshotTables(fixture.tx, tables, {
          games: ["owner_user_id"],
          game_participants: ["user_id"],
        }),
      ).toEqual(before);
      expect(
        (await fixture.tx.execute(sql`select distinct owner_user_id from games`)).rows,
      ).toEqual([{ owner_user_id: null }]);
      expect(
        (await fixture.tx.execute(sql`select distinct user_id from game_participants`)).rows,
      ).toEqual([{ user_id: null }]);
    });
  });

  it("0011 preserves account owners, human seats and provider images without inferring profiles", async () => {
    await withMigrationSchema(database, async (fixture) => {
      await populateHistoricalSchema(fixture, "0010_account_owned_games");
      const tables = [...authTables, ...gameTables];
      const before = await snapshotTables(fixture.tx, tables);
      await fixture.applyMigration("0011_profiles");
      expect(await snapshotTables(fixture.tx, tables)).toEqual(before);
      expect((await fixture.tx.execute(sql`select * from profiles`)).rows).toEqual([]);
    });
  });

  it("0014 adds the private account history index without rewriting populated records", async () => {
    await withMigrationSchema(database, async (fixture) => {
      const { tx, schemaName, applyMigration } = fixture;
      await populateHistoricalSchema(fixture, "0013_owner_scoped_credential_ids");
      const before = await snapshotTables(tx, credentialTables);
      await applyMigration("0014_account_history_index");
      expect(await snapshotTables(tx, credentialTables)).toEqual(before);
      const indexes = (
        await tx.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes where schemaname = ${schemaName} and indexname = 'games_account_history_idx'`)
      ).rows;
      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.indexdef).toContain(
        "owner_user_id, updated_at DESC NULLS LAST, id DESC NULLS LAST",
      );
    });
  });
});
