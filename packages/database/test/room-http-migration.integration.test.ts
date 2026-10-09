import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";

it("upgrades populated rooms without changing admission, operations, seats, history or solo commands", async () => {
  const database = integrationDatabase();
  const schema = `room_http_upgrade_${randomUUID().replaceAll("-", "")}`;
  const folder = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(folder))
    .filter((name) => /^\d{4}.*\.sql$/.test(name) && name < "0019")
    .sort();
  const sources = await Promise.all(
    [...names, "0019_room_http_commands.sql"].map((name) =>
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
      for (const id of [owner, opponent]) {
        await tx.execute(
          sql`insert into "user"(id, name, email) values (${id}, '', ${id + "@example.com"})`,
        );
      }
      const waiting = randomUUID();
      const joined = randomUUID();
      const solo = randomUUID();
      await tx.execute(sql`insert into games(id, owner_user_id, mode, state, result, termination_reason, fen, pgn, version) values
        (${waiting}, ${owner}, 'human_vs_human', 'paused', '*', null, 'waiting-fen', 'waiting-pgn', 0),
        (${joined}, ${owner}, 'human_vs_human', 'aborted', '*', 'aborted', 'joined-fen', 'joined-pgn', 1),
        (${solo}, ${owner}, 'ai_vs_ai', 'aborted', '*', 'aborted', 'solo-fen', 'solo-pgn', 1)`);
      await tx.execute(sql`insert into game_participants(game_id, color, seat_type, user_id) values
        (${waiting}, 'white', 'human', ${owner}), (${waiting}, 'black', 'human', null),
        (${joined}, 'white', 'human', ${owner}), (${joined}, 'black', 'human', ${opponent})`);
      await tx.execute(sql`insert into rooms(game_id, owner_color, state, invitation_digest, joined_at) values
        (${waiting}, 'white', 'waiting', ${"a".repeat(64)}, null), (${joined}, 'white', 'joined', null, clock_timestamp())`);
      await tx.execute(
        sql`insert into game_commands(game_id, command_id, kind, version) values (${solo}, ${randomUUID()}, 'abort', 1)`,
      );
      await tx.execute(
        sql`insert into game_slots(game_id, scope, user_id) values (${waiting}, 'ordinary', ${owner})`,
      );
      await tx.execute(
        sql`insert into room_history_access(game_id, user_id) values (${waiting}, ${owner}), (${joined}, ${owner}), (${joined}, ${opponent})`,
      );
      await tx.execute(sql`insert into room_creation_operations(user_id, operation_id, issued_at, expires_at, state, owner_color, game_id)
        values (${owner}, ${randomUUID()}, statement_timestamp(), statement_timestamp() + interval '10 minutes', 'consumed', 'white', ${waiting})`);
      const tables = [
        "games",
        "game_participants",
        "game_commands",
        "game_slots",
        "room_history_access",
        "room_creation_operations",
      ];
      const read = (table: string) =>
        tx.execute(
          sql`select to_jsonb(t) as record from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
        );
      const before = [];
      for (const table of tables) before.push((await read(table)).rows);
      await apply(sources.at(-1)!);
      const after = [];
      for (const table of tables) after.push((await read(table)).rows);
      expect(after).toEqual(before);
      expect(
        (
          await tx.execute(
            sql`select game_id, invitation_digest, join_command_id, joined_invitation_digest from rooms order by state`,
          )
        ).rows,
      ).toEqual([
        {
          game_id: joined,
          invitation_digest: null,
          join_command_id: null,
          joined_invitation_digest: null,
        },
        {
          game_id: waiting,
          invitation_digest: "a".repeat(64),
          join_command_id: null,
          joined_invitation_digest: null,
        },
      ]);
      await expect(
        tx.transaction((savepoint) =>
          savepoint.execute(
            sql`update rooms set join_command_id = ${randomUUID()}, joined_invitation_digest = 'raw-code' where game_id = ${joined}`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
      const commandId = randomUUID();
      await tx.execute(
        sql`update rooms set join_command_id = ${commandId}, joined_invitation_digest = ${"b".repeat(64)} where game_id = ${joined}`,
      );
      await expect(
        tx.transaction((savepoint) =>
          savepoint.execute(
            sql`update rooms set join_command_id = ${commandId}, joined_invitation_digest = ${"b".repeat(64)} where game_id = ${waiting}`,
          ),
        ),
      ).rejects.toThrow();
      await tx.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
    });
  } finally {
    await database.close();
  }
});
