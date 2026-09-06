import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { aiConfigurationChecks, aiConfigurationColumns } from "./ai-fields.js";

export { aiProvider } from "./ai-fields.js";

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
export const gameMode = pgEnum("game_mode", ["human_vs_human", "ai_vs_ai", "ai_vs_human"]);
export const gameCommandKind = pgEnum("game_command_kind", [
  "move",
  "pause",
  "resume",
  "abort",
  "resign",
  "technical_loss",
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
    mode: gameMode("mode").notNull().default("human_vs_human"),
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
    uniqueIndex("games_id_owner_unique").on(table.id, table.ownerGuestSessionId),
    check(
      "games_sandbox_mode_check",
      sql`not ${table.isSandbox} or ${table.mode} = 'human_vs_human'`,
    ),
    uniqueIndex("games_one_unfinished_per_guest")
      .on(table.ownerGuestSessionId)
      .where(sql`${table.state} in ('active', 'paused')`),
    check("games_version_check", sql`${table.version} between 0 and 9007199254740991`),
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
    ...aiConfigurationColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("game_participants_color_unique").on(table.gameId, table.color),
    uniqueIndex("game_participants_color_type_unique").on(
      table.gameId,
      table.color,
      table.seatType,
    ),
    uniqueIndex("game_participants_guest_unique").on(table.gameId, table.guestSessionId),
    index("game_participants_guest_idx").on(table.guestSessionId),
    check(
      "game_participants_identity_check",
      sql`${table.seatType} = 'human' or ${table.guestSessionId} is null`,
    ),
    check(
      "game_participants_configuration_check",
      sql`(${table.seatType} = 'ai' and ${table.provider} is not null and ${table.modelId} is not null)
        or (${table.seatType} = 'human' and ${table.provider} is null and ${table.modelId} is null
          and ${table.temperature} is null and ${table.reasoningEffort} is null and ${table.maxOutputTokens} is null)`,
    ),
    ...aiConfigurationChecks("game_participants", table),
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

export const turnReservationStatus = pgEnum("turn_reservation_status", [
  "reserved",
  "committed",
  "cancelled",
  "abandoned",
]);

export const turnReservations = pgTable(
  "turn_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id").notNull(),
    ownerGuestSessionId: uuid("owner_guest_session_id").notNull(),
    commandId: uuid("command_id").notNull(),
    expectedVersion: bigint("expected_version", { mode: "number" }).notNull(),
    color: chessColor("color").notNull(),
    seatType: seatType("seat_type").notNull().default("ai"),
    executorId: uuid("executor_id").notNull(),
    status: turnReservationStatus("status").notNull().default("reserved"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.gameId, table.ownerGuestSessionId],
      foreignColumns: [games.id, games.ownerGuestSessionId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.gameId, table.color, table.seatType],
      foreignColumns: [gameParticipants.gameId, gameParticipants.color, gameParticipants.seatType],
    }).onDelete("cascade"),
    uniqueIndex("turn_reservations_id_game_unique").on(table.id, table.gameId),
    uniqueIndex("turn_reservations_command_unique").on(table.gameId, table.commandId),
    uniqueIndex("turn_reservations_version_unique").on(table.gameId, table.expectedVersion),
    uniqueIndex("turn_reservations_one_pending_per_game")
      .on(table.gameId)
      .where(sql`${table.status} = 'reserved'`),
    check("turn_reservations_ai_check", sql`${table.seatType} = 'ai'`),
    check(
      "turn_reservations_version_check",
      sql`${table.expectedVersion} between 0 and 9007199254740990`,
    ),
    check("turn_reservations_lease_check", sql`${table.leaseExpiresAt} > ${table.createdAt}`),
    check(
      "turn_reservations_status_check",
      sql`(${table.status} = 'reserved' and ${table.endedAt} is null)
        or (${table.status} <> 'reserved' and ${table.endedAt} is not null and ${table.endedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const invocationStatus = pgEnum("invocation_status", [
  "pending",
  "succeeded",
  "model_invalid",
  "provider_error",
  "abandoned",
]);
export const invocationErrorKind = pgEnum("invocation_error_kind", [
  "model_invalid",
  "provider_auth",
  "provider_quota",
  "provider_timeout",
  "provider_unavailable",
]);
export const modelInvalidReason = pgEnum("model_invalid_reason", [
  "malformed_output",
  "illegal_move",
]);

export const modelInvocations = pgTable(
  "model_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id").notNull(),
    gameId: uuid("game_id").notNull(),
    attempt: integer("attempt").notNull(),
    ...aiConfigurationColumns(),
    status: invocationStatus("status").notNull().default("pending"),
    move: text("move"),
    commentary: text("commentary"),
    errorKind: invocationErrorKind("error_kind"),
    invalidReason: modelInvalidReason("invalid_reason"),
    latencyMs: doublePrecision("latency_ms"),
    usageReported: boolean("usage_reported").notNull().default(false),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    totalTokens: bigint("total_tokens", { mode: "number" }),
    providerRequestId: text("provider_request_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.reservationId, table.gameId],
      foreignColumns: [turnReservations.id, turnReservations.gameId],
    }).onDelete("cascade"),
    index("model_invocations_game_idx").on(table.gameId),
    uniqueIndex("model_invocations_attempt_unique").on(table.reservationId, table.attempt),
    uniqueIndex("model_invocations_one_pending")
      .on(table.reservationId)
      .where(sql`${table.status} = 'pending'`),
    check("model_invocations_attempt_check", sql`${table.attempt} between 1 and 3`),
    check(
      "model_invocations_configuration_check",
      sql`${table.provider} is not null and ${table.modelId} is not null`,
    ),
    ...aiConfigurationChecks("model_invocations", table),
    check(
      "model_invocations_result_check",
      sql`(${table.status} = 'succeeded' and ${table.move} is not null and ${table.errorKind} is null and ${table.invalidReason} is null)
        or (${table.status} = 'model_invalid' and ${table.move} is null and ${table.commentary} is null
          and ${table.errorKind} is not null and ${table.errorKind} = 'model_invalid' and ${table.invalidReason} is not null)
        or (${table.status} = 'provider_error' and ${table.move} is null and ${table.commentary} is null
          and ${table.errorKind} is not null and ${table.errorKind} <> 'model_invalid' and ${table.invalidReason} is null)
        or (${table.status} in ('pending', 'abandoned') and ${table.move} is null and ${table.commentary} is null
          and ${table.errorKind} is null and ${table.invalidReason} is null)`,
    ),
    check(
      "model_invocations_move_check",
      sql`${table.move} ~ '^[a-h][1-8][a-h][1-8][qrbn]?$' and length(${table.move}) in (4, 5)
        and left(${table.move}, 2) <> substring(${table.move} from 3 for 2)`,
    ),
    check("model_invocations_commentary_check", sql`length(${table.commentary}) <= 2000`),
    check(
      "model_invocations_timing_check",
      sql`(${table.status} = 'pending' and ${table.finishedAt} is null)
        or (${table.status} <> 'pending' and ${table.finishedAt} is not null and ${table.finishedAt} >= ${table.startedAt})`,
    ),
    check(
      "model_invocations_telemetry_check",
      sql`(${table.status} in ('pending', 'abandoned') and ${table.latencyMs} is null and not ${table.usageReported} and ${table.providerRequestId} is null)
        or (${table.status} in ('succeeded', 'model_invalid', 'provider_error') and ${table.latencyMs} is not null
          and ${table.latencyMs} >= 0 and ${table.latencyMs} < 'Infinity'::float8)`,
    ),
    check(
      "model_invocations_usage_check",
      sql`${table.usageReported} or (${table.inputTokens} is null and ${table.outputTokens} is null and ${table.totalTokens} is null)`,
    ),
    ...(["inputTokens", "outputTokens", "totalTokens"] as const).map((key) =>
      check(`model_invocations_${key}_check`, sql`${table[key]} between 0 and 9007199254740991`),
    ),
    check(
      "model_invocations_request_id_check",
      sql`length(${table.providerRequestId}) between 1 and 200 and ${table.providerRequestId} !~ '[^a-zA-Z0-9_.:-]'`,
    ),
  ],
);
