import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { games } from "./games.js";

export const roomHistoryAccess = pgTable(
  "room_history_access",
  {
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.userId] }),
    index("room_history_access_user_idx").on(table.userId, table.gameId),
  ],
);
