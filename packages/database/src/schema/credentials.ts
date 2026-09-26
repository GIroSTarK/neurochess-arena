import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth.js";

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["openai", "anthropic", "google", "openrouter"] }).notNull(),
    label: text("label").notNull(),
    maskedSuffix: text("masked_suffix"),
    version: integer("version").notNull(),
    keyId: text("key_id").notNull(),
    nonce: text("nonce").notNull(),
    authTag: text("auth_tag").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("provider_credentials_owner_id_idx").on(table.userId, table.id),
    check(
      "provider_credentials_provider_valid",
      sql`${table.provider} in ('openai', 'anthropic', 'google', 'openrouter')`,
    ),
    check(
      "provider_credentials_label_valid",
      sql`length(${table.label}) between 1 and 64 and ${table.label} = btrim(${table.label}) and ${table.label} !~ '[[:cntrl:]<>]'`,
    ),
    check(
      "provider_credentials_suffix_valid",
      sql`${table.maskedSuffix} is null or (length(${table.maskedSuffix}) = 4 and ${table.maskedSuffix} collate "C" ~ '^[A-Za-z0-9_-]{4}$')`,
    ),
    check("provider_credentials_version_valid", sql`${table.version} = 1`),
    check(
      "provider_credentials_key_id_valid",
      sql`length(${table.keyId}) between 1 and 32 and ${table.keyId} collate "C" ~ '^[A-Za-z0-9_-]+$'`,
    ),
    check(
      "provider_credentials_nonce_valid",
      sql`length(${table.nonce}) = 24 and ${table.nonce} collate "C" ~ '^[0-9a-f]+$'`,
    ),
    check(
      "provider_credentials_tag_valid",
      sql`length(${table.authTag}) = 32 and ${table.authTag} collate "C" ~ '^[0-9a-f]+$'`,
    ),
    check(
      "provider_credentials_ciphertext_valid",
      sql`length(${table.ciphertext}) between 2 and 8192 and length(${table.ciphertext}) % 2 = 0 and ${table.ciphertext} collate "C" ~ '^[0-9a-f]+$'`,
    ),
  ],
);
