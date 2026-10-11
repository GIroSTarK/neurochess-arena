import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";

it("adds bounded private samples to a populated schema without rewriting games and cascades either foreign key", async () => {
  const database = integrationDatabase();
  const schema = `analysis_upgrade_${randomUUID().replaceAll("-", "")}`;
  const folder = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(folder))
    .filter((name) => /^\d{4}.*\.sql$/.test(name) && name < "0020")
    .sort();
  const sources = await Promise.all(
    [...names, "0020_private_analysis_samples.sql"].map((name) =>
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
      const peer = randomUUID();
      const solo = randomUUID();
      const room = randomUUID();
      const session = randomUUID();
      for (const id of [owner, peer]) {
        await tx.execute(
          sql`insert into "user"(id, name, email) values (${id}, '', ${id + "@example.com"})`,
        );
      }
      await tx.execute(
        sql`insert into session(id, user_id, token, expires_at, updated_at) values (${session}, ${owner}, ${randomUUID()}, clock_timestamp() + interval '1 hour', clock_timestamp())`,
      );
      await tx.execute(sql`insert into games(id, owner_user_id, mode, state, result, termination_reason, fen, pgn, version) values
        (${solo}, ${owner}, 'ai_vs_ai', 'active', '*', null, 'solo-fen', 'solo-pgn', 1),
        (${room}, ${owner}, 'human_vs_human', 'aborted', '*', 'aborted', 'room-fen', 'room-pgn', 1)`);
      await tx.execute(
        sql`insert into game_participants(game_id, color, seat_type, user_id) values (${room}, 'white', 'human', ${owner}), (${room}, 'black', 'human', ${peer})`,
      );
      await tx.execute(
        sql`insert into rooms(game_id, owner_color, state, invitation_digest, joined_at) values (${room}, 'white', 'joined', null, clock_timestamp())`,
      );
      await tx.execute(
        sql`insert into room_history_access(game_id, user_id) values (${room}, ${owner}), (${room}, ${peer})`,
      );
      await tx.execute(
        sql`insert into moves(game_id, ply, uci, san, fen, command_id, version) values (${solo}, 1, 'e2e4', 'e4', 'moved-fen', ${randomUUID()}, 1)`,
      );
      await tx.execute(
        sql`insert into game_commands(game_id, command_id, kind, version) values (${solo}, ${randomUUID()}, 'move', 1)`,
      );
      await tx.execute(
        sql`insert into game_slots(game_id, scope, user_id) values (${solo}, 'ordinary', ${owner})`,
      );
      await tx.execute(
        sql`insert into ai_controllers(game_id, controller_id, expires_at) values (${solo}, ${randomUUID()}, clock_timestamp() + interval '1 hour')`,
      );
      const tables = [
        "user",
        "session",
        "games",
        "game_participants",
        "moves",
        "game_commands",
        "game_slots",
        "ai_controllers",
        "rooms",
        "room_history_access",
      ];
      const read = async () => {
        const rows = [];
        for (const table of tables) {
          rows.push(
            (
              await tx.execute(
                sql`select to_jsonb(t) as record from ${sql.identifier(table)} t order by to_jsonb(t)::text`,
              )
            ).rows,
          );
        }
        return rows;
      };
      const before = await read();
      await apply(sources.at(-1)!);
      expect(await read()).toEqual(before);
      expect((await tx.execute(sql`select * from game_analysis_samples`)).rowCount).toBe(0);
      for (const [userId, gameId] of [
        [owner, solo],
        [owner, room],
        [peer, room],
      ]) {
        await tx.execute(sql`insert into game_analysis_samples(user_id, game_id, ply, fen, history_digest, profile_id, depth, duration_ms, centipawns)
          values (${userId}, ${gameId}, 0, 'initial-fen', ${"a".repeat(64)}, 'sf19-lite-single-v1', 0, 0, 0)`);
      }
      await expect(
        tx.transaction((savepoint) =>
          savepoint.execute(
            sql`insert into game_analysis_samples select * from game_analysis_samples limit 1`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      const invalidUpdates = [
        sql`ply = -1`,
        sql`depth = 19`,
        sql`duration_ms = 3001`,
        sql`centipawns = 100001`,
        sql`centipawns = null`,
        sql`mate_winner = 'white', mate_moves = 1`,
        sql`centipawns = null, mate_winner = 'white', mate_moves = -1`,
        sql`centipawns = null, mate_winner = 'white', mate_moves = 129`,
        sql`centipawns = null, mate_winner = 'invalid', mate_moves = 1`,
        sql`fen = ${"x".repeat(129)}`,
        sql`history_digest = 'invalid'`,
        sql`profile_id = ${"x".repeat(65)}`,
      ];
      for (const change of invalidUpdates) {
        await expect(
          tx.transaction((savepoint) =>
            savepoint.execute(sql`update game_analysis_samples set ${change}`),
          ),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
      }
      await expect(
        tx.transaction((savepoint) =>
          savepoint.execute(
            sql`update game_analysis_samples set user_id = ${randomUUID()} where game_id = ${solo}`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: "23503" } });
      await tx.execute(
        sql`update game_analysis_samples set centipawns = null, mate_winner = 'black', mate_moves = 0 where game_id = ${solo}`,
      );
      await tx.execute(sql`delete from games where id = ${solo}`);
      expect(
        (await tx.execute(sql`select * from game_analysis_samples where game_id = ${solo}`))
          .rowCount,
      ).toBe(0);
      await tx.execute(sql`update game_participants set user_id = null where user_id = ${peer}`);
      await tx.execute(sql`delete from "user" where id = ${peer}`);
      expect((await tx.execute(sql`select user_id from game_analysis_samples`)).rows).toEqual([
        { user_id: owner },
      ]);
      await tx.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
    });
  } finally {
    await database.close();
  }
});
