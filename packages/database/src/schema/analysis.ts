import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { games } from "./games.js";

export const gameAnalysisSamples = pgTable(
  "game_analysis_samples",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    ply: integer("ply").notNull(),
    fen: text("fen").notNull(),
    historyDigest: text("history_digest").notNull(),
    profileId: text("profile_id").notNull(),
    depth: integer("depth").notNull(),
    durationMs: integer("duration_ms").notNull(),
    centipawns: integer("centipawns"),
    mateWinner: text("mate_winner", { enum: ["white", "black"] }),
    mateMoves: integer("mate_moves"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.gameId, table.ply] }),
    index("game_analysis_samples_game_idx").on(table.gameId),
    check("game_analysis_samples_ply_check", sql`${table.ply} >= 0`),
    check(
      "game_analysis_samples_identity_check",
      sql`length(${table.fen}) between 1 and 128
    and ${table.historyDigest} ~ '^[0-9a-f]{64}$'
    and ${table.profileId} ~ '^[a-zA-Z0-9-]{1,64}$'`,
    ),
    check(
      "game_analysis_samples_limits_check",
      sql`${table.depth} between 0 and 18 and ${table.durationMs} between 0 and 3000`,
    ),
    check(
      "game_analysis_samples_score_check",
      sql`((
    ${table.centipawns} is not null and ${table.centipawns} between -100000 and 100000
    and ${table.mateWinner} is null and ${table.mateMoves} is null
  ) or (
    ${table.centipawns} is null and ${table.mateWinner} in ('white', 'black')
    and ${table.mateMoves} between 0 and 128
  )) is true`,
    ),
  ],
);
