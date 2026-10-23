import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import type { DatabaseConnection } from "../src/index.js";

import {
  authTables,
  credentialTables,
  gameTables,
  historicalData,
  profileTables,
} from "./historical-migration-fixture.js";
import { snapshotTables, withMigrationSchema } from "./migration-fixture.js";

let database: DatabaseConnection;
beforeAll(() => {
  database = integrationDatabase();
});
afterAll(async () => {
  await database.close();
});

it("preserves a populated historical upgrade from 0001 through 0018 including encrypted credentials", async () => {
  await withMigrationSchema(database, async ({ tx, applyMigration }) => {
    const data = historicalData(tx);
    await applyMigration("0001_guest_owned_games");
    await data.seedAfterMigration("0001_guest_owned_games");
    const legacyTables = ["guest_sessions", "games", "game_participants", "moves"];
    const legacy = await snapshotTables(tx, legacyTables);
    await applyMigration("0002_game_command_receipts");
    const commands = await snapshotTables(tx, ["game_commands"]);
    await applyMigration("0003_ai_game_configuration");
    expect(
      await snapshotTables(tx, legacyTables, {
        games: ["mode"],
        game_participants: ["provider", "model_id", "parameters"],
      }),
    ).toEqual(legacy);
    await data.seedAfterMigration("0003_ai_game_configuration");
    const configured = await snapshotTables(tx, [...legacyTables, "game_commands"]);
    for (const name of [
      "0004_ai_turn_reservations",
      "0005_ai_invocation_policy",
      "0006_ai_controller_presence",
      "0007_separate_sandbox_game_slot",
    ] as const) {
      await applyMigration(name);
      await data.seedAfterMigration(name);
    }
    expect(await snapshotTables(tx, Object.keys(configured))).toEqual(configured);
    const gamesBeforeAuth = await snapshotTables(tx, gameTables);
    await applyMigration("0008_better_auth_foundation");
    await data.seedAfterMigration("0008_better_auth_foundation");
    const auth = await snapshotTables(tx, authTables);
    await applyMigration("0009_oauth_account_identity");
    expect(await snapshotTables(tx, gameTables)).toEqual(gamesBeforeAuth);
    await applyMigration("0010_account_owned_games");
    expect(
      await snapshotTables(tx, gameTables, {
        games: ["owner_user_id"],
        game_participants: ["user_id"],
      }),
    ).toEqual(gamesBeforeAuth);
    expect(await snapshotTables(tx, authTables)).toEqual(auth);
    await data.seedAfterMigration("0010_account_owned_games");
    const beforeProfiles = await snapshotTables(tx, [...authTables, ...gameTables]);
    await applyMigration("0011_profiles");
    expect(await snapshotTables(tx, Object.keys(beforeProfiles))).toEqual(beforeProfiles);
    await data.seedAfterMigration("0011_profiles");
    const beforeCredentials = await snapshotTables(tx, profileTables);
    await applyMigration("0012_provider_credentials");
    expect(await snapshotTables(tx, profileTables)).toEqual(beforeCredentials);
    await data.seedAfterMigration("0012_provider_credentials");
    const beforeFinalUpgrades = await snapshotTables(tx, credentialTables);
    for (const name of [
      "0013_owner_scoped_credential_ids",
      "0014_account_history_index",
      "0015_private_room_foundation",
      "0016_participant_game_slots",
      "0017_backfill_participant_game_slots",
      "0018_shared_room_history",
    ] as const) {
      await applyMigration(name);
    }
    expect(await snapshotTables(tx, credentialTables)).toEqual(beforeFinalUpgrades);
    expect(await snapshotTables(tx, ["game_commands"])).toEqual(commands);
    expect(await data.decryptedCredential()).toBe("migration-fixture-key-1234");
    expect(
      (await tx.execute(sql`select owner_user_id from games where id = ${data.accountGameId}`))
        .rows,
    ).toEqual([{ owner_user_id: data.authUserId }]);
    expect(
      (
        await tx.execute(
          sql`select scope, count(*)::int as count from game_slots group by scope order by scope`,
        )
      ).rows,
    ).toEqual([
      { scope: "ordinary", count: 2 },
      { scope: "sandbox", count: 2 },
    ]);
  });
});
