import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const accountDeletionMarkers = pgTable(
  "account_deletion_markers",
  {
    fingerprint: text("fingerprint").primaryKey(),
    cutoff: timestamp("cutoff", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("account_deletion_markers_expiry_idx").on(table.expiresAt),
    check(
      "account_deletion_markers_fingerprint_check",
      sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check("account_deletion_markers_expiry_check", sql`${table.expiresAt} > ${table.cutoff}`),
  ],
);
