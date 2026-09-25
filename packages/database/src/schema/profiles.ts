import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { user } from "./auth.js";

export const profiles = pgTable(
  "profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    username: text("username"),
    usernameNormalized: text("username_normalized"),
    // The imported URL remains in Better Auth's user.image; this choice survives every sign-in.
    avatarPreference: text("avatar_preference", { enum: ["provider", "initials"] })
      .default("provider")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("profiles_username_normalized_unique").on(table.usernameNormalized),
    check(
      "profiles_username_valid",
      sql`(
    (${table.username} is null and ${table.usernameNormalized} is null) or
    (${table.username} is not null and ${table.usernameNormalized} is not null
      and length(${table.username}) between 3 and 24
      and ${table.username} collate "C" ~ '^[A-Za-z][A-Za-z0-9_]*$'
      and ${table.usernameNormalized} = translate(${table.username}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
      and ${table.usernameNormalized} not in ('admin', 'administrator', 'api', 'auth', 'guest', 'help', 'moderator', 'neurochess', 'root', 'sandbox', 'security', 'support', 'system', 'www'))
  )`,
    ),
    check(
      "profiles_avatar_preference_valid",
      sql`${table.avatarPreference} in ('provider', 'initials')`,
    ),
  ],
);
