import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { games, guestSessions } from "./games.js";

export const gameSlots = pgTable(
  "game_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["ordinary", "sandbox"] }).notNull(),
    userId: uuid("user_id").references(() => user.id),
    guestSessionId: uuid("guest_session_id").references(() => guestSessions.id),
  },
  (table) => [
    index("game_slots_game_idx").on(table.gameId),
    uniqueIndex("game_slots_account_scope_unique").on(table.userId, table.scope),
    uniqueIndex("game_slots_guest_scope_unique").on(table.guestSessionId, table.scope),
    check(
      "game_slots_identity_check",
      sql`num_nonnulls(${table.userId}, ${table.guestSessionId}) = 1`,
    ),
    check(
      "game_slots_scope_check",
      sql`${table.scope} in ('ordinary', 'sandbox') and (${table.scope} = 'ordinary' or ${table.guestSessionId} is not null)`,
    ),
  ],
);
