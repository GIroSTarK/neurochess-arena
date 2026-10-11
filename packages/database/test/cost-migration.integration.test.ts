import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";

it("upgrades populated attempts with unknown historical costs, preserves old columns and enforces bounded estimates", async () => {
  const database = integrationDatabase();
  const schema = `cost_upgrade_${randomUUID().replaceAll("-", "")}`;
  const folder = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(folder))
    .filter((name) => /^\d{4}.*\.sql$/.test(name) && name < "0021")
    .sort();
  const sources = await Promise.all(
    [...names, "0021_invocation_cost_estimates.sql"].map((name) =>
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
        sql`insert into ai_turns(id, game_id, ply, color, attempt_count, invalid_output_count) values (${turn}, ${game}, 1, 'white', 2, 1)`,
      );
      await tx.execute(sql`insert into model_invocations(turn_id, attempt_number, reservation_id, command_id, expected_version, provider, model_id, effective_parameters, outcome, error_code, error_reason, duration_ms, usage_reported, input_tokens, output_tokens)
        values (${turn}, 1, ${randomUUID()}, ${randomUUID()}, 0, 'openai', 'historic', '{}', 'model_invalid', 'model_invalid', 'illegal_move', 1, true, 100, 0),
        (${turn}, 2, ${randomUUID()}, ${randomUUID()}, 0, 'openai', 'historic', '{}', 'in_flight', null, null, null, false, null, null)`);
      const before = (
        await tx.execute(
          sql`select to_jsonb(t) as record from model_invocations t order by attempt_number`,
        )
      ).rows;
      const originalGame = (await tx.execute(sql`select to_jsonb(games) as record from games`))
        .rows;
      await apply(sources.at(-1)!);
      expect(
        (
          await tx.execute(
            sql`select to_jsonb(t) - array['billing_usage', 'pricing_version', 'pricing_source', 'pricing_checked_at', 'pricing_rates', 'pricing_unavailable_reason', 'cost_amount', 'cost_currency', 'cost_unavailable_reason'] as record from model_invocations t order by attempt_number`,
          )
        ).rows,
      ).toEqual(before);
      expect((await tx.execute(sql`select to_jsonb(games) as record from games`)).rows).toEqual(
        originalGame,
      );
      expect(
        (
          await tx.execute(
            sql`select cost_amount, cost_unavailable_reason from model_invocations order by attempt_number`,
          )
        ).rows,
      ).toEqual([
        { cost_amount: null, cost_unavailable_reason: "legacy_record" },
        { cost_amount: null, cost_unavailable_reason: "legacy_record" },
      ]);
      for (const change of [
        sql`cost_amount = 0`,
        sql`cost_unavailable_reason = null`,
        sql`cost_unavailable_reason = 'invented'`,
        sql`cost_currency = 'EUR'`,
        sql`pricing_version = '2026-10-11.1'`,
        sql`billing_usage = '[]'::jsonb`,
        sql`billing_usage = ${JSON.stringify({ raw: "x".repeat(2048) })}::jsonb`,
      ]) {
        await expect(
          tx.transaction((savepoint) =>
            savepoint.execute(sql`update model_invocations set ${change} where attempt_number = 1`),
          ),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
      }
      await tx.execute(sql`update model_invocations set pricing_version = '2026-10-11.1', pricing_source = 'https://developers.openai.com/api/docs/models/gpt-5-mini', pricing_checked_at = '2026-10-11', pricing_rates = '{"inputTokens":"0.25","cachedInputTokens":"0.025","outputTokens":"2"}', pricing_unavailable_reason = null,
        billing_usage = '{"status":"reported","provider":"openai","pricingMatch":"standard","dimensions":{"inputTokens":0,"cachedInputTokens":0,"outputTokens":0}}', cost_amount = 0, cost_unavailable_reason = null where attempt_number = 1`);
      for (const change of [
        sql`cost_amount = -1`,
        sql`cost_amount = 'NaN'::numeric`,
        sql`pricing_rates = '[]'::jsonb`,
      ]) {
        await expect(
          tx.transaction((savepoint) =>
            savepoint.execute(sql`update model_invocations set ${change} where attempt_number = 1`),
          ),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
      }
      await tx.execute(sql`delete from games where id = ${game}`);
      expect((await tx.execute(sql`select * from model_invocations`)).rowCount).toBe(0);
      await tx.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
    });
  } finally {
    await database.close();
  }
});
