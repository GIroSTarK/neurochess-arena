import { sql } from "drizzle-orm";
export * from "./auth.js";
import {
  bigint,
  boolean,
  check,
  foreignKey,
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

import { user } from "./auth.js";

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
    ownerGuestSessionId: uuid("owner_guest_session_id").references(() => guestSessions.id),
    ownerUserId: text("owner_user_id").references(() => user.id),
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
    index("games_owner_user_idx").on(table.ownerUserId),
    uniqueIndex("games_one_unfinished_per_account")
      .on(table.ownerUserId)
      .where(sql`${table.state} in ('active', 'paused')`),
    check(
      "games_owner_check",
      sql`num_nonnulls(${table.ownerGuestSessionId}, ${table.ownerUserId}) = 1`,
    ),
    check("games_sandbox_owner_check", sql`not ${table.isSandbox} or ${table.ownerUserId} is null`),
    uniqueIndex("games_one_unfinished_per_guest_scope")
      .on(table.ownerGuestSessionId, table.isSandbox)
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
    userId: text("user_id").references(() => user.id),
    provider: aiProvider("provider"),
    modelId: text("model_id"),
    parameters: jsonb("parameters").$type<StoredAiParameters>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("game_participants_color_unique").on(table.gameId, table.color),
    uniqueIndex("game_participants_guest_unique").on(table.gameId, table.guestSessionId),
    index("game_participants_guest_idx").on(table.guestSessionId),
    uniqueIndex("game_participants_user_unique").on(table.gameId, table.userId),
    index("game_participants_user_idx").on(table.userId),
    check(
      "game_participants_identity_check",
      sql`num_nonnulls(${table.guestSessionId}, ${table.userId}) <= 1
        and (${table.seatType} = 'human' or (${table.guestSessionId} is null and ${table.userId} is null))`,
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

export const aiControllers = pgTable(
  "ai_controllers",
  {
    gameId: uuid("game_id")
      .primaryKey()
      .references(() => games.id, { onDelete: "cascade" }),
    controllerId: uuid("controller_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("ai_controllers_expiry_idx").on(table.expiresAt)],
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

export const aiTurns = pgTable(
  "ai_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    ply: integer("ply").notNull(),
    color: chessColor("color").notNull(),
    invalidOutputCount: integer("invalid_output_count").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    acceptedMovePly: integer("accepted_move_ply"),
  },
  (table) => [
    uniqueIndex("ai_turns_ply_unique").on(table.gameId, table.ply),
    foreignKey({
      columns: [table.gameId, table.acceptedMovePly],
      foreignColumns: [moves.gameId, moves.ply],
    }).onDelete("cascade"),
    check(
      "ai_turns_ply_check",
      sql`${table.ply} > 0 and (${table.acceptedMovePly} is null or ${table.acceptedMovePly} = ${table.ply})`,
    ),
    check(
      "ai_turns_budget_check",
      sql`${table.invalidOutputCount} between 0 and 3 and ${table.attemptCount} >= ${table.invalidOutputCount}`,
    ),
    check(
      "ai_turns_color_check",
      sql`(${table.ply} % 2 = 1 and ${table.color} = 'white') or (${table.ply} % 2 = 0 and ${table.color} = 'black')`,
    ),
  ],
);

export const modelInvocations = pgTable(
  "model_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => aiTurns.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    commandId: uuid("command_id").notNull(),
    expectedVersion: bigint("expected_version", { mode: "number" }).notNull(),
    provider: aiProvider("provider").notNull(),
    modelId: text("model_id").notNull(),
    effectiveParameters: jsonb("effective_parameters").$type<StoredAiParameters>().notNull(),
    outcome: text("outcome", {
      enum: [
        "in_flight",
        "accepted",
        "model_invalid",
        "provider_error",
        "interrupted",
        "discarded",
      ],
    })
      .notNull()
      .default("in_flight"),
    errorCode: text("error_code", {
      enum: [
        "model_invalid",
        "provider_auth",
        "provider_quota",
        "provider_timeout",
        "provider_unavailable",
      ],
    }),
    errorReason: text("error_reason", {
      enum: [
        "malformed_output",
        "illegal_move",
        "refusal",
        "truncated_output",
        "network",
        "upstream",
        "invalid_response",
        "unsupported_model",
        "cancelled",
      ],
    }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    usageReported: boolean("usage_reported").notNull().default(false),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    totalTokens: bigint("total_tokens", { mode: "number" }),
    commentary: text("commentary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("model_invocations_attempt_unique").on(table.turnId, table.attemptNumber),
    index("model_invocations_reservation_idx").on(table.reservationId),
    uniqueIndex("model_invocations_pending_unique")
      .on(table.reservationId)
      .where(sql`${table.outcome} = 'in_flight'`),
    uniqueIndex("model_invocations_accepted_unique")
      .on(table.turnId)
      .where(sql`${table.outcome} = 'accepted'`),
    check(
      "model_invocations_sequence_check",
      sql`${table.attemptNumber} > 0 and ${table.expectedVersion} between 0 and 9007199254740991`,
    ),
    check(
      "model_invocations_outcome_check",
      sql`${table.outcome} in ('in_flight', 'accepted', 'model_invalid', 'provider_error', 'interrupted', 'discarded')`,
    ),
    check(
      "model_invocations_error_check",
      sql`
      ((${table.errorCode} is null and ${table.errorReason} is null)
      or (${table.errorCode} = 'model_invalid' and ${table.errorReason} is not null and ${table.errorReason} in ('malformed_output', 'illegal_move', 'refusal', 'truncated_output'))
      or (${table.errorCode} in ('provider_auth', 'provider_quota', 'provider_timeout') and ${table.errorReason} is null)
      or (${table.errorCode} = 'provider_unavailable' and ${table.errorReason} is not null and ${table.errorReason} in ('network', 'upstream', 'invalid_response', 'unsupported_model', 'cancelled'))) is true`,
    ),
    check(
      "model_invocations_result_check",
      sql`
      (${table.outcome} in ('in_flight', 'interrupted') and ${table.errorCode} is null and ${table.durationMs} is null and not ${table.usageReported} and ${table.commentary} is null)
      or (${table.durationMs} is not null and (
        (${table.outcome} = 'accepted' and ${table.errorCode} is null)
        or (${table.commentary} is null and (
          (${table.outcome} = 'model_invalid' and ${table.errorCode} is not null and ${table.errorCode} = 'model_invalid')
          or (${table.outcome} = 'provider_error' and ${table.errorCode} is not null and ${table.errorCode} <> 'model_invalid')
          or ${table.outcome} = 'discarded'))))`,
    ),
    check(
      "model_invocations_usage_check",
      sql`(${table.usageReported} or (${table.inputTokens} is null and ${table.outputTokens} is null and ${table.totalTokens} is null))
      and (${table.durationMs} is null or ${table.durationMs} between 0 and 9007199254740991)
      and (${table.inputTokens} is null or ${table.inputTokens} between 0 and 9007199254740991)
      and (${table.outputTokens} is null or ${table.outputTokens} between 0 and 9007199254740991)
      and (${table.totalTokens} is null or ${table.totalTokens} between 0 and 9007199254740991)`,
    ),
    check(
      "model_invocations_commentary_check",
      sql`${table.commentary} is null or length(${table.commentary}) <= 2000`,
    ),
    check(
      "model_invocations_model_id_check",
      sql`length(${table.modelId}) between 1 and 256 and ${table.modelId} ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$'`,
    ),
    check(
      "model_invocations_parameters_check",
      sql`jsonb_typeof(${table.effectiveParameters}) = 'object'
      and octet_length(${table.effectiveParameters}::text) <= 512
      and ${table.effectiveParameters} - array['temperature', 'reasoningEffort', 'maxOutputTokens'] = '{}'::jsonb
      and (not (${table.effectiveParameters} ? 'temperature') or case
        when jsonb_typeof(${table.effectiveParameters}->'temperature') = 'number'
        then (${table.effectiveParameters}->>'temperature')::numeric between 0 and 9007199254740991 else false end)
      and (not (${table.effectiveParameters} ? 'reasoningEffort') or (
        jsonb_typeof(${table.effectiveParameters}->'reasoningEffort') = 'string'
        and length(${table.effectiveParameters}->>'reasoningEffort') between 1 and 64
        and ${table.effectiveParameters}->>'reasoningEffort' ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'))
      and (not (${table.effectiveParameters} ? 'maxOutputTokens') or case
        when jsonb_typeof(${table.effectiveParameters}->'maxOutputTokens') = 'number'
        then (${table.effectiveParameters}->>'maxOutputTokens')::numeric between 1 and 9007199254740991
          and mod((${table.effectiveParameters}->>'maxOutputTokens')::numeric, 1) = 0 else false end)`,
    ),
  ],
);
