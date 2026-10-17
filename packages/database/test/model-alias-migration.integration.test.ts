import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";

it("preserves existing model IDs while enabling bounded alias prefixes in seats and invocations", async () => {
  const database = integrationDatabase();
  const schema = `model_alias_upgrade_${randomUUID().replaceAll("-", "")}`;
  const folder = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(folder))
    .filter((name) => /^\d{4}.*\.sql$/.test(name) && name < "0022")
    .sort();
  const sources = await Promise.all(
    [...names, "0022_model_alias_prefix.sql"].map((name) =>
      readFile(new URL(name, folder), "utf8"),
    ),
  );
  try {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`create schema ${sql.identifier(schema)}`);
      await tx.execute(sql`set local search_path to ${sql.identifier(schema)}`);
      const apply = async (source: string) => {
        for (const statement of source
          .split("--> statement-breakpoint")
          .filter((part) => part.trim())) {
          await tx.execute(sql.raw(statement.replaceAll('"public"', '"' + schema + '"')));
        }
      };
      for (const source of sources.slice(0, -1)) await apply(source);
      const owner = randomUUID();
      const game = randomUUID();
      const turn = randomUUID();
      await tx.execute(
        sql`insert into "user"(id, name, email) values (${owner}, '', ${owner + "@example.com"})`,
      );
      await tx.execute(
        sql`insert into games(id, owner_user_id, mode, state, result, fen, pgn) values (${game}, ${owner}, 'ai_vs_human', 'active', '*', 'fen', 'pgn')`,
      );
      await tx.execute(
        sql`insert into game_participants(game_id, color, seat_type, provider, model_id, parameters) values (${game}, 'white', 'ai', 'openrouter', 'vendor/model', '{}')`,
      );
      await tx.execute(
        sql`insert into ai_turns(id, game_id, ply, color, attempt_count) values (${turn}, ${game}, 1, 'white', 1)`,
      );
      await tx.execute(
        sql`insert into model_invocations(turn_id, attempt_number, reservation_id, command_id, expected_version, provider, model_id, effective_parameters) values (${turn}, 1, ${randomUUID()}, ${randomUUID()}, 0, 'openrouter', 'vendor/model', '{}')`,
      );
      const alias = "~anthropic/claude-sonnet-latest";
      const tables = ["game_participants", "model_invocations"] as const;
      const before = [];
      for (const table of tables) {
        before.push((await tx.execute(sql`select * from ${sql.identifier(table)}`)).rows);
        await expect(
          tx.transaction((savepoint) =>
            savepoint.execute(sql`update ${sql.identifier(table)} set model_id = ${alias}`),
          ),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
      }
      await apply(sources.at(-1)!);
      for (const [index, table] of tables.entries()) {
        expect((await tx.execute(sql`select * from ${sql.identifier(table)}`)).rows).toEqual(
          before[index],
        );
        for (const modelId of [alias, "~vendor/model:free", `~${"x".repeat(255)}`]) {
          await tx.execute(sql`update ${sql.identifier(table)} set model_id = ${modelId}`);
          expect(
            (await tx.execute(sql`select model_id from ${sql.identifier(table)}`)).rows,
          ).toEqual([{ model_id: modelId }]);
        }
        for (const modelId of [
          "~",
          "~~vendor/model",
          "vendor/~model",
          "~vendor/model\n",
          `~${"x".repeat(256)}`,
        ]) {
          await expect(
            tx.transaction((savepoint) =>
              savepoint.execute(sql`update ${sql.identifier(table)} set model_id = ${modelId}`),
            ),
          ).rejects.toMatchObject({ cause: { code: "23514" } });
        }
      }
      await tx.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
    });
  } finally {
    await database.close();
  }
});
