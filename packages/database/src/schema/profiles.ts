import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth.js";

export const profiles = pgTable(
  "profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    username: text("username"),
    usernameNormalized: text("username_normalized"),
    avatarRemoved: boolean("avatar_removed").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("profiles_username_normalized_unique").on(table.usernameNormalized),
    check(
      "profiles_username_valid",
      sql`
    (${table.username} is null and ${table.usernameNormalized} is null) or
    (${table.username} is not null and ${table.usernameNormalized} is not null
      and ${table.username} collate "C" ~ '^[A-Za-z0-9_]{3,24}$'
      and ${table.usernameNormalized} = lower(${table.username} collate "C")
      and ${table.usernameNormalized} not in (
        'admin', 'administrator', 'api', 'arena', 'auth', 'guest', 'help', 'login',
        'logout', 'moderator', 'neurochess', 'root', 'security', 'support', 'system', 'www'
      ))`,
    ),
  ],
);
