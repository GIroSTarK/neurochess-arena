import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import type { DatabaseConnection } from "../src/index.js";

import {
  credentialTables,
  populateHistoricalSchema,
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

describe("credential migrations", () => {
  it("0012 adds empty credential storage without rewriting populated auth, profiles or games", async () => {
    await withMigrationSchema(database, async (fixture) => {
      await populateHistoricalSchema(fixture, "0011_profiles");
      const before = await snapshotTables(fixture.tx, profileTables);
      await fixture.applyMigration("0012_provider_credentials");
      expect(await snapshotTables(fixture.tx, profileTables)).toEqual(before);
      expect((await fixture.tx.execute(sql`select * from provider_credentials`)).rows).toEqual([]);
    });
  });

  it("0013 preserves encrypted credentials and scopes duplicate IDs to their owners", async () => {
    await withMigrationSchema(database, async (fixture) => {
      const { tx, applyMigration } = fixture;
      const data = await populateHistoricalSchema(fixture, "0012_provider_credentials");
      const { authUserId, credentialId } = data;
      const before = await snapshotTables(tx, credentialTables);
      await applyMigration("0013_owner_scoped_credential_ids");
      expect(await snapshotTables(tx, credentialTables)).toEqual(before);
      expect(await data.decryptedCredential()).toBe("migration-fixture-key-1234");

      const otherOwner = randomUUID();
      await tx.execute(
        sql`insert into "user"(id, name, email) values (${otherOwner}, '', 'other-upgrade@example.com')`,
      );
      const other = await tx.execute(sql`
        insert into provider_credentials(id, user_id, provider, label, version, key_id, nonce, auth_tag, ciphertext)
        select id, ${otherOwner}, provider, 'Independent', version, key_id, nonce, auth_tag, ciphertext
        from provider_credentials where user_id = ${authUserId} and id = ${credentialId}
        on conflict (user_id, id) do nothing returning id`);
      expect(other.rows).toEqual([{ id: credentialId }]);
      const duplicate = await tx.execute(sql`
        insert into provider_credentials(id, user_id, provider, label, version, key_id, nonce, auth_tag, ciphertext)
        select id, user_id, provider, 'Replacement', version, key_id, nonce, auth_tag, ciphertext
        from provider_credentials where user_id = ${authUserId} and id = ${credentialId}
        on conflict (user_id, id) do nothing returning id`);
      expect(duplicate.rows).toEqual([]);
      expect(
        (
          await tx.execute(sql`
        select label from provider_credentials where user_id = ${authUserId} and id = ${credentialId}`)
        ).rows,
      ).toEqual([{ label: "Preserved" }]);
    });
  });
});
