import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";

it("upgrades populated rooms with one entitlement per seated account and preserves solo records", async () => {
  const database = integrationDatabase();
  const schema = `history_upgrade_${randomUUID().replaceAll("-", "")}`;
  const folder = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(folder))
    .filter((name) => /^\d{4}.*\.sql$/.test(name) && name < "0018")
    .sort();
  const sources = await Promise.all(
    [...names, "0018_shared_room_history.sql"].map((name) =>
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
      const opponent = randomUUID();
      const guest = randomUUID();
      for (const id of [owner, opponent]) {
        await tx.execute(
          sql`insert into "user"(id, name, email) values (${id}, '', ${id + "@example.com"})`,
        );
      }
      await tx.execute(
        sql`insert into guest_sessions(id, token_hash, expires_at) values (${guest}, ${guest.replaceAll("-", "").repeat(2)}, clock_timestamp() + interval '1 hour')`,
      );
      const joined = randomUUID();
      const waiting = randomUUID();
      const terminal = randomUUID();
      const solo = randomUUID();
      await tx.execute(sql`insert into games(id, owner_user_id, mode, state, result, termination_reason, fen, pgn) values
        (${joined}, ${owner}, 'human_vs_human', 'completed', '0-1', 'checkmate', 'joined-fen', 'joined-pgn'),
        (${waiting}, ${owner}, 'human_vs_human', 'paused', '*', null, 'waiting-fen', 'waiting-pgn'),
        (${terminal}, null, 'human_vs_human', 'aborted', '*', 'aborted', 'guest-fen', 'guest-pgn'),
        (${solo}, ${owner}, 'ai_vs_human', 'aborted', '*', 'aborted', 'solo-fen', 'solo-pgn')`);
      await tx.execute(sql`insert into game_participants(game_id, color, seat_type, user_id, guest_session_id) values
        (${joined}, 'white', 'human', ${owner}, null), (${joined}, 'black', 'human', ${opponent}, null),
        (${waiting}, 'white', 'human', ${owner}, null), (${waiting}, 'black', 'human', null, null),
        (${terminal}, 'white', 'human', null, null), (${terminal}, 'black', 'human', null, ${guest}),
        (${solo}, 'white', 'human', ${owner}, null)`);
      const before = (await tx.execute(sql`select to_jsonb(g) as game from games g order by id`))
        .rows;
      await apply(sources.at(-1)!);
      expect(
        (await tx.execute(sql`select game_id, user_id from room_history_access`)).rows,
      ).toEqual(
        expect.arrayContaining([
          { game_id: joined, user_id: owner },
          { game_id: joined, user_id: opponent },
          { game_id: waiting, user_id: owner },
        ]),
      );
      expect((await tx.execute(sql`select * from room_history_access`)).rowCount).toBe(3);
      expect(
        (await tx.execute(sql`select to_jsonb(g) as game from games g order by id`)).rows,
      ).toEqual(before);
      await expect(
        tx.transaction((savepoint) =>
          savepoint.execute(
            sql`insert into room_history_access(game_id, user_id) values (${joined}, ${owner})`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      await tx.execute(sql`delete from games where id = ${joined}`);
      expect(
        (await tx.execute(sql`select * from room_history_access where game_id = ${joined}`))
          .rowCount,
      ).toBe(0);
      await tx.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
    });
  } finally {
    await database.close();
  }
});
