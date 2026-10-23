import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import type { DatabaseConnection } from "../src/index.js";

import { credentialTables, populateHistoricalSchema } from "./historical-migration-fixture.js";
import { snapshotTables, withMigrationSchema } from "./migration-fixture.js";

let database: DatabaseConnection;
beforeAll(() => {
  database = integrationDatabase();
});
afterAll(async () => {
  await database.close();
});

describe("room foundation and slot migrations", () => {
  it("0015 preserves solo data while adding the human room mode", async () => {
    await withMigrationSchema(database, async (fixture) => {
      const { tx, schemaName, applyMigration } = fixture;
      await populateHistoricalSchema(fixture, "0014_account_history_index");
      const before = await snapshotTables(tx, credentialTables);
      await applyMigration("0015_private_room_foundation");
      expect(await snapshotTables(tx, credentialTables)).toEqual(before);
      expect((await tx.execute(sql`select * from rooms`)).rows).toEqual([]);
      expect((await tx.execute(sql`select * from room_creation_operations`)).rows).toEqual([]);
      const modes = await tx.execute<{ enumlabel: string }>(sql`
        select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = ${schemaName} and t.typname = 'ai_game_mode' order by e.enumsortorder`);
      expect(modes.rows.map((row) => row.enumlabel)).toEqual([
        "ai_vs_ai",
        "ai_vs_human",
        "human_vs_human",
      ]);
    });
  });

  it("0016–0018 preserve historical data and backfill account, seatless AI-owner and Sandbox slots", async () => {
    await withMigrationSchema(database, async (fixture) => {
      const { tx, applyMigration } = fixture;
      const { accountGameId, authUserId, aiGame, aiOwner } = await populateHistoricalSchema(
        fixture,
        "0015_private_room_foundation",
      );
      const before = await snapshotTables(tx, credentialTables);
      await applyMigration("0016_participant_game_slots");
      await applyMigration("0017_backfill_participant_game_slots");
      await applyMigration("0018_shared_room_history");
      expect(await snapshotTables(tx, credentialTables)).toEqual(before);
      const slots = (
        await tx.execute<{
          game_id: string;
          scope: string;
          user_id: string | null;
          guest_session_id: string | null;
        }>(sql`select game_id, scope, user_id, guest_session_id from game_slots`)
      ).rows;
      expect(slots).toHaveLength(4);
      expect(slots).toContainEqual({
        game_id: accountGameId,
        scope: "ordinary",
        user_id: authUserId,
        guest_session_id: null,
      });
      expect(slots).toContainEqual({
        game_id: aiGame,
        scope: "ordinary",
        user_id: null,
        guest_session_id: aiOwner,
      });
      expect(slots.filter((slot) => slot.scope === "sandbox")).toHaveLength(2);
      expect((await tx.execute(sql`select * from rooms`)).rows).toEqual([]);
      expect((await tx.execute(sql`select * from room_creation_operations`)).rows).toEqual([]);
      expect((await tx.execute(sql`select * from room_history_access`)).rows).toEqual([]);
      for (const mode of [null, "ai_vs_ai", "ai_vs_human"]) {
        const gameId = randomUUID();
        await tx.execute(sql`
          insert into games(id, owner_guest_session_id, mode, state, result, termination_reason, fen, pgn)
          values (${gameId}, ${aiOwner}, ${mode}, 'aborted', '*', 'aborted', 'position', 'history')`);
        await expect(
          tx.transaction((savepoint) =>
            savepoint.execute(sql`
          update games set owner_guest_session_id = null where id = ${gameId}`),
          ),
          `solo mode ${mode ?? "legacy"} still requires an owner after the room upgrade`,
        ).rejects.toMatchObject({ cause: { code: "23514", constraint: "games_owner_check" } });
      }
    });
  });
});
