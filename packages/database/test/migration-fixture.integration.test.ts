import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import type { DatabaseConnection } from "../src/index.js";

import { withMigrationSchema } from "./migration-fixture.js";

let database: DatabaseConnection;
beforeAll(() => {
  database = integrationDatabase();
});
afterAll(async () => {
  await database.close();
});

it.each(["success", "assertion failure", "SQL failure"] as const)(
  "cleans up the isolated migration schema after %s",
  async (outcome) => {
    let schemaName = "";
    const searchPath = (await database.db.execute(sql`show search_path`)).rows;
    const scenario = withMigrationSchema(database, async (fixture) => {
      schemaName = fixture.schemaName;
      await fixture.applyMigration("0001_guest_owned_games");
      expect((await fixture.tx.execute(sql`select current_schema() as name`)).rows).toEqual([
        { name: schemaName },
      ]);
      if (outcome === "assertion failure") expect("actual").toBe("expected");
      if (outcome === "SQL failure") await fixture.tx.execute(sql`select 1 / 0`);
    });
    if (outcome === "success") await scenario;
    else if (outcome === "SQL failure") {
      await expect(scenario).rejects.toMatchObject({ cause: { code: "22012" } });
    } else await expect(scenario).rejects.toThrow("expected");
    expect(schemaName).not.toBe("");
    expect(
      (
        await database.db.execute(
          sql`select nspname from pg_namespace where nspname = ${schemaName}`,
        )
      ).rows,
    ).toEqual([]);
    expect((await database.db.execute(sql`show search_path`)).rows).toEqual(searchPath);
  },
);
