import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Database literals are intentionally independent of the chess and transport leaves.
export const gameState = pgEnum("game_state", [
  "configuring",
  "active",
  "paused",
  "completed",
  "aborted",
]);
export const gameResult = pgEnum("game_result", ["*", "1-0", "0-1", "1/2-1/2"]);
export const terminationReason = pgEnum("termination_reason", [
  "checkmate",
  "human_resignation",
  "model_technical_loss",
  "stalemate",
  "insufficient_material",
  "threefold_repetition",
  "fifty_move_rule",
  "aborted",
]);
export const chessColor = pgEnum("chess_color", ["white", "black"]);
export const seatType = pgEnum("seat_type", ["human", "ai"]);
export const aiGameMode = pgEnum("ai_game_mode", ["ai_vs_ai", "ai_vs_human"]);
export const aiProvider = pgEnum("ai_provider", ["openai", "anthropic", "google", "openrouter"]);

export interface StoredAiParameters {
  temperature?: number | undefined;
  reasoningEffort?: string | undefined;
  maxOutputTokens?: number | undefined;
}
export const gameCommandKind = pgEnum("game_command_kind", [
  "move",
  "pause",
  "resume",
  "abort",
  "resign",
]);

export const guestSessions = pgTable(
  "guest_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("guest_sessions_token_hash_unique").on(table.tokenHash),
    index("guest_sessions_expiry_idx").on(table.expiresAt),
    check("guest_sessions_token_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("guest_sessions_expiry_check", sql`${table.expiresAt} > ${table.lastSeenAt}`),
  ],
);

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerGuestSessionId: uuid("owner_guest_session_id")
      .notNull()
      .references(() => guestSessions.id),
    isSandbox: boolean("is_sandbox").notNull().default(false),
    // Null preserves pre-AI records without assigning them a public AI mode.
    mode: aiGameMode("mode"),
    state: gameState("state").notNull(),
    result: gameResult("result").notNull(),
    terminationReason: terminationReason("termination_reason"),
    fen: text("fen").notNull(),
    pgn: text("pgn").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("games_owner_idx").on(table.ownerGuestSessionId),
    uniqueIndex("games_one_unfinished_per_guest")
      .on(table.ownerGuestSessionId)
      .where(sql`${table.state} in ('active', 'paused')`),
    check("games_version_check", sql`${table.version} between 0 and 9007199254740991`),
    check("games_sandbox_mode_check", sql`not ${table.isSandbox} or ${table.mode} is null`),
    check("games_position_check", sql`length(${table.fen}) > 0 and length(${table.pgn}) > 0`),
    check(
      "games_lifecycle_check",
      sql`
    (${table.state} in ('configuring', 'active', 'paused') and ${table.result} = '*' and ${table.terminationReason} is null)
    or (${table.state} = 'completed' and ${table.result} in ('1-0', '0-1') and ${table.terminationReason} is not null
      and ${table.terminationReason} in ('checkmate', 'human_resignation', 'model_technical_loss'))
    or (${table.state} = 'completed' and ${table.result} = '1/2-1/2' and ${table.terminationReason} is not null
      and ${table.terminationReason} in ('stalemate', 'insufficient_material', 'threefold_repetition', 'fifty_move_rule'))
    or (${table.state} = 'aborted' and ${table.result} = '*' and ${table.terminationReason} is not null
      and ${table.terminationReason} = 'aborted')
  `,
    ),
  ],
);

export const gameParticipants = pgTable(
  "game_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    color: chessColor("color").notNull(),
    seatType: seatType("seat_type").notNull(),
    guestSessionId: uuid("guest_session_id").references(() => guestSessions.id),
    provider: aiProvider("provider"),
    modelId: text("model_id"),
    parameters: jsonb("parameters").$type<StoredAiParameters>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("game_participants_color_unique").on(table.gameId, table.color),
    uniqueIndex("game_participants_guest_unique").on(table.gameId, table.guestSessionId),
    index("game_participants_guest_idx").on(table.guestSessionId),
    check(
      "game_participants_identity_check",
      sql`${table.seatType} = 'human' or ${table.guestSessionId} is null`,
    ),
    check(
      "game_participants_configuration_check",
      sql`(${table.seatType} = 'human' and ${table.provider} is null
        and ${table.modelId} is null and ${table.parameters} is null)
      or (${table.seatType} = 'ai' and ${table.provider} is not null
        and ${table.modelId} is not null and ${table.parameters} is not null)`,
    ),
    check(
      "game_participants_model_id_check",
      sql`${table.modelId} is null or (length(${table.modelId}) between 1 and 256
        and ${table.modelId} ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$')`,
    ),
    check(
      "game_participants_parameters_check",
      sql`${table.parameters} is null or (
        jsonb_typeof(${table.parameters}) = 'object'
        and octet_length(${table.parameters}::text) <= 512
        and ${table.parameters} - array['temperature', 'reasoningEffort', 'maxOutputTokens'] = '{}'::jsonb
        and (not (${table.parameters} ? 'temperature') or case
          when jsonb_typeof(${table.parameters}->'temperature') = 'number'
          then (${table.parameters}->>'temperature')::numeric between 0 and 9007199254740991
          else false end)
        and (not (${table.parameters} ? 'reasoningEffort') or (
          jsonb_typeof(${table.parameters}->'reasoningEffort') = 'string'
          and length(${table.parameters}->>'reasoningEffort') between 1 and 64
          and ${table.parameters}->>'reasoningEffort' ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'))
        and (not (${table.parameters} ? 'maxOutputTokens') or case
          when jsonb_typeof(${table.parameters}->'maxOutputTokens') = 'number'
          then (${table.parameters}->>'maxOutputTokens')::numeric between 1 and 9007199254740991
            and mod((${table.parameters}->>'maxOutputTokens')::numeric, 1) = 0
          else false end)
      )`,
    ),
  ],
);

export const moves = pgTable(
  "moves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    ply: integer("ply").notNull(),
    uci: text("uci").notNull(),
    san: text("san").notNull(),
    fen: text("fen").notNull(),
    commandId: uuid("command_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("moves_ply_unique").on(table.gameId, table.ply),
    uniqueIndex("moves_command_unique").on(table.gameId, table.commandId),
    uniqueIndex("moves_version_unique").on(table.gameId, table.version),
    check("moves_ply_check", sql`${table.ply} > 0`),
    check("moves_version_check", sql`${table.version} between 1 and 9007199254740991`),
    check(
      "moves_uci_check",
      sql`${table.uci} ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'
    and length(${table.uci}) in (4, 5) and left(${table.uci}, 2) <> substring(${table.uci} from 3 for 2)`,
    ),
    check("moves_position_check", sql`length(${table.san}) > 0 and length(${table.fen}) > 0`),
  ],
);

export const gameCommands = pgTable(
  "game_commands",
  {
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    commandId: uuid("command_id").notNull(),
    kind: gameCommandKind("kind").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.commandId] }),
    uniqueIndex("game_commands_version_unique").on(table.gameId, table.version),
    check("game_commands_version_check", sql`${table.version} between 1 and 9007199254740991`),
  ],
);

export const aiTurnReservations = pgTable(
  "ai_turn_reservations",
  {
    gameId: uuid("game_id")
      .primaryKey()
      .references(() => games.id, { onDelete: "cascade" }),
    reservationId: uuid("reservation_id").notNull(),
    commandId: uuid("command_id").notNull(),
    expectedVersion: bigint("expected_version", { mode: "number" }).notNull(),
    state: text("state", { enum: ["in_flight", "blocked"] })
      .notNull()
      .default("in_flight"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "ai_turn_reservations_version_check",
      sql`${table.expectedVersion} between 0 and 9007199254740991`,
    ),
    check("ai_turn_reservations_state_check", sql`${table.state} in ('in_flight', 'blocked')`),
  ],
);
