import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import type { DatabaseConnection } from "../src/index.js";

import { gameTables, populateHistoricalSchema } from "./historical-migration-fixture.js";
import { snapshotTables, withMigrationSchema } from "./migration-fixture.js";

let database: DatabaseConnection;
beforeAll(() => {
  database = integrationDatabase();
});
afterAll(async () => {
  await database.close();
});

describe("legacy game migrations", () => {
  it("0002 backfills pre-existing move identities with the actual forward migration", async () => {
    await withMigrationSchema(database, async (fixture) => {
      const { tx, applyMigration } = fixture;
      await populateHistoricalSchema(fixture, "0001_guest_owned_games");
      const before = await snapshotTables(tx, [
        "guest_sessions",
        "games",
        "game_participants",
        "moves",
      ]);
      const expected = (
        await tx.execute(sql`
        select game_id, command_id, 'move' as kind, version from moves order by game_id`)
      ).rows;
      await applyMigration("0002_game_command_receipts");
      expect(
        (
          await tx.execute(sql`
        select game_id, command_id, kind, version from game_commands order by game_id`)
        ).rows,
      ).toEqual(expected);
      expect(expected).toHaveLength(4);
      expect(await snapshotTables(tx, Object.keys(before))).toEqual(before);
    });
  });

  it("0003 preserves all legacy lifecycle states and Sandbox authority without inventing AI configuration", async () => {
    await withMigrationSchema(database, async (fixture) => {
      const { tx, applyMigration } = fixture;
      await populateHistoricalSchema(fixture, "0002_game_command_receipts");
      const tables = ["guest_sessions", "games", "game_participants", "moves", "game_commands"];
      const before = await snapshotTables(tx, tables);
      await applyMigration("0003_ai_game_configuration");
      expect(
        await snapshotTables(tx, tables, {
          games: ["mode"],
          game_participants: ["provider", "model_id", "parameters"],
        }),
      ).toEqual(before);
      expect((await tx.execute(sql`select distinct mode from games`)).rows).toEqual([
        { mode: null },
      ]);
      expect(
        (
          await tx.execute(sql`
        select distinct provider, model_id, parameters from game_participants`)
        ).rows,
      ).toEqual([{ provider: null, model_id: null, parameters: null }]);
    });
  });

  it.each([
    {
      migration: "0004_ai_turn_reservations",
      prior: "0003_ai_game_configuration",
      tables: ["guest_sessions", "games", "game_participants", "moves", "game_commands"],
      added: ["ai_turn_reservations"],
    },
    {
      migration: "0005_ai_invocation_policy",
      prior: "0004_ai_turn_reservations",
      tables: [
        "guest_sessions",
        "games",
        "game_participants",
        "moves",
        "game_commands",
        "ai_turn_reservations",
      ],
      added: ["ai_turns", "model_invocations"],
    },
    {
      migration: "0006_ai_controller_presence",
      prior: "0005_ai_invocation_policy",
      tables: gameTables.filter((table) => table !== "ai_controllers"),
      added: ["ai_controllers"],
    },
  ] as const)(
    "$migration preserves populated game/execution records without invented history",
    async ({ migration, prior, tables, added }) => {
      await withMigrationSchema(database, async (fixture) => {
        await populateHistoricalSchema(fixture, prior);
        const before = await snapshotTables(fixture.tx, tables);
        await fixture.applyMigration(migration);
        expect(await snapshotTables(fixture.tx, tables)).toEqual(before);
        for (const table of added) {
          expect(
            (await fixture.tx.execute(sql`select * from ${sql.identifier(table)}`)).rows,
            table,
          ).toEqual([]);
        }
      });
    },
  );

  it("0007 replaces the unfinished-owner index with a scoped index without rewriting games or execution", async () => {
    await withMigrationSchema(database, async (fixture) => {
      const { tx, schemaName, applyMigration } = fixture;
      await populateHistoricalSchema(fixture, "0006_ai_controller_presence");
      const before = await snapshotTables(tx, gameTables);
      await applyMigration("0007_separate_sandbox_game_slot");
      expect(await snapshotTables(tx, gameTables)).toEqual(before);
      const indexes = (
        await tx.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes where schemaname = ${schemaName}
        and indexname in ('games_one_unfinished_per_guest', 'games_one_unfinished_per_guest_scope')`)
      ).rows;
      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.indexdef).toContain("UNIQUE INDEX");
      expect(indexes[0]!.indexdef).toContain("games_one_unfinished_per_guest_scope");
      expect(indexes[0]!.indexdef).toContain("(owner_guest_session_id, is_sandbox)");
      expect(indexes[0]!.indexdef).toContain("active");
      expect(indexes[0]!.indexdef).toContain("paused");
    });
  });
});
