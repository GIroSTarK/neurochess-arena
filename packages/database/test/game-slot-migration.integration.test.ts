import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";

describe("populated participant slot upgrade", () => {
  it.each([false, true])(
    "backfills owners, participants and independent Sandbox slots atomically (conflicting participation: %s)",
    async (conflict) => {
      const database = integrationDatabase();
      const schema = `slot_upgrade_${randomUUID().replaceAll("-", "")}`;
      const folder = new URL("../drizzle/", import.meta.url);
      const prior = (await readdir(folder))
        .filter((name) => /^\d{4}.*\.sql$/.test(name) && name < "0016")
        .sort();
      const sources = await Promise.all(
        [
          ...prior,
          "0016_participant_game_slots.sql",
          "0017_backfill_participant_game_slots.sql",
        ].map((name) => readFile(new URL(name, folder), "utf8")),
      );
      try {
        await database.db.transaction(async (tx) => {
          await tx.execute(sql`create schema ${sql.identifier(schema)}`);
          await tx.execute(sql`set local search_path to ${sql.identifier(schema)}`);
          const apply = async (executor: typeof tx, source: string) => {
            for (const statement of source
              .split("--> statement-breakpoint")
              .filter((part) => part.trim())) {
              await executor.execute(sql.raw(statement.replaceAll('"public"', '"' + schema + '"')));
            }
          };
          for (const source of sources.slice(0, -2)) await apply(tx, source);
          const users = Array.from({ length: 4 }, () => randomUUID());
          for (const id of users) {
            await tx.execute(
              sql`insert into "user"(id, name, email) values (${id}, '', ${id + "@example.com"})`,
            );
          }
          const guest = randomUUID();
          await tx.execute(
            sql`insert into guest_sessions(id, token_hash, expires_at) values (${guest}, ${guest.replaceAll("-", "").repeat(2)}, clock_timestamp() + interval '1 hour')`,
          );
          const joined = randomUUID();
          const waiting = randomUUID();
          const ai = randomUUID();
          const sandbox = randomUUID();
          const terminal = randomUUID();
          await tx.execute(sql`
          insert into games(id, owner_user_id, owner_guest_session_id, is_sandbox, mode, state, result, termination_reason, fen, pgn)
          values (${joined}, ${users[0]}, null, false, 'human_vs_human', 'active', '*', null, 'room-position', 'room-history'),
                 (${waiting}, ${users[2]}, null, false, 'human_vs_human', 'paused', '*', null, 'waiting-position', 'waiting-history'),
                 (${ai}, ${conflict ? users[1] : users[3]}, null, false, 'ai_vs_ai', 'paused', '*', null, 'ai-position', 'ai-history'),
                 (${sandbox}, null, ${guest}, true, null, 'active', '*', null, 'sandbox-position', 'sandbox-history'),
                 (${terminal}, ${users[0]}, null, false, 'human_vs_human', 'aborted', '*', 'aborted', 'terminal-position', 'terminal-history')`);
          await tx.execute(sql`
          insert into game_participants(game_id, color, seat_type, user_id, guest_session_id)
          values (${joined}, 'white', 'human', ${users[0]}, null), (${joined}, 'black', 'human', ${users[1]}, null),
                 (${waiting}, 'white', 'human', ${users[2]}, null), (${waiting}, 'black', 'human', null, ${guest}),
                 (${terminal}, 'white', 'human', ${users[0]}, null), (${terminal}, 'black', 'human', ${users[1]}, null)`);
          await tx.execute(
            sql`insert into rooms(game_id, owner_color, state, joined_at) values (${joined}, 'white', 'joined', now()), (${waiting}, 'white', 'joined', now()), (${terminal}, 'white', 'joined', now())`,
          );
          const before = (
            await tx.execute(sql`select to_jsonb(g) as game from games g order by id`)
          ).rows;
          const migrateSlots = () =>
            tx.transaction(async (savepoint) => {
              for (const source of sources.slice(-2)) await apply(savepoint, source);
            });
          if (conflict) {
            await expect(migrateSlots()).rejects.toMatchObject({ cause: { code: "23505" } });
            expect(
              (await tx.execute(sql`select to_regclass('game_slots') as table_name`)).rows,
            ).toEqual([{ table_name: null }]);
          } else {
            await migrateSlots();
            const slots = (
              await tx.execute(
                sql`select game_id, scope, user_id, guest_session_id from game_slots`,
              )
            ).rows;
            expect(slots).toHaveLength(6);
            expect(slots).toEqual(
              expect.arrayContaining([
                { game_id: joined, scope: "ordinary", user_id: users[0], guest_session_id: null },
                { game_id: joined, scope: "ordinary", user_id: users[1], guest_session_id: null },
                { game_id: waiting, scope: "ordinary", user_id: users[2], guest_session_id: null },
                { game_id: waiting, scope: "ordinary", user_id: null, guest_session_id: guest },
                { game_id: ai, scope: "ordinary", user_id: users[3], guest_session_id: null },
                { game_id: sandbox, scope: "sandbox", user_id: null, guest_session_id: guest },
              ]),
            );
          }
          expect(
            (await tx.execute(sql`select to_jsonb(g) as game from games g order by id`)).rows,
          ).toEqual(before);
          await expect(
            tx.transaction((savepoint) =>
              savepoint.execute(sql`
          insert into games(owner_user_id, mode, state, result, fen, pgn)
          values (${users[0]}, 'ai_vs_ai', 'active', '*', 'duplicate', 'duplicate')`),
            ),
          ).rejects.toMatchObject({ cause: { code: "23505" } });
          await tx.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
        });
      } finally {
        await database.close();
      }
    },
  );
});
