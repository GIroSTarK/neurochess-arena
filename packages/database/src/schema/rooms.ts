import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { chessColor, games } from "./games.js";

export const rooms = pgTable(
  "rooms",
  {
    gameId: uuid("game_id")
      .primaryKey()
      .references(() => games.id, { onDelete: "cascade" }),
    ownerColor: chessColor("owner_color").notNull(),
    state: text("state", { enum: ["waiting", "joined"] }).notNull(),
    invitationDigest: text("invitation_digest"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("rooms_invitation_digest_unique").on(table.invitationDigest),
    check(
      "rooms_invitation_digest_check",
      sql`${table.invitationDigest} is null or ${table.invitationDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "rooms_admission_check",
      sql`
    (${table.state} = 'waiting' and ${table.joinedAt} is null)
    or (${table.state} = 'joined' and ${table.joinedAt} is not null and ${table.invitationDigest} is null)`,
    ),
  ],
);

export const roomCreationOperations = pgTable(
  "room_creation_operations",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    state: text("state", { enum: ["pending", "consumed"] }).notNull(),
    ownerColor: chessColor("owner_color"),
    // Cleanup removes the result, not the consumed operation that fences delayed retries.
    gameId: uuid("game_id").references(() => games.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("room_creation_operations_id_unique").on(table.operationId),
    check(
      "room_creation_operations_expiry_check",
      sql`${table.expiresAt} = ${table.issuedAt} + interval '10 minutes'`,
    ),
    check(
      "room_creation_operations_state_check",
      sql`
    (${table.state} = 'pending' and ${table.ownerColor} is null and ${table.gameId} is null)
    or (${table.state} = 'consumed' and ${table.ownerColor} is not null)`,
    ),
  ],
);
