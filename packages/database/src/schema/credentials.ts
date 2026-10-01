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

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    maskedSuffix: text("masked_suffix"),
    version: integer("version").notNull(),
    keyId: text("key_id").notNull(),
    nonce: text("nonce").notNull(),
    authTag: text("auth_tag").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    index("provider_credentials_owner_created_idx").on(table.userId, table.createdAt, table.id),
    check(
      "provider_credentials_provider_valid",
      sql`${table.provider} in ('openai', 'anthropic', 'google', 'openrouter')`,
    ),
    check(
      "provider_credentials_label_valid",
      sql`char_length(${table.label}) between 1 and 64 and ${table.label} = btrim(${table.label}) and ${table.label} !~ '[[:cntrl:]]'`,
    ),
    check(
      "provider_credentials_suffix_valid",
      sql`${table.maskedSuffix} is null or ${table.maskedSuffix} collate "C" ~ '^[A-Za-z0-9_-]{4}$'`,
    ),
    check(
      "provider_credentials_envelope_valid",
      sql`${table.version} = 1
    and char_length(${table.keyId}) between 1 and 64 and ${table.keyId} collate "C" ~ '^[A-Za-z0-9_-]+$'
    and ${table.nonce} collate "C" ~ '^[a-f0-9]{24}$'
    and ${table.authTag} collate "C" ~ '^[a-f0-9]{32}$'
    and char_length(${table.ciphertext}) between 2 and 8192 and ${table.ciphertext} collate "C" ~ '^([a-f0-9]{2})+$'`,
    ),
  ],
);
