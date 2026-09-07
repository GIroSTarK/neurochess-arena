import { z } from "zod";

import { modelInvalidErrorSchema, providerErrorSchema, tokenUsageSchema } from "./ai-telemetry.js";
import { safeErrorResponseSchema } from "./system.js";

export const chessColorSchema = z.enum(["white", "black"]);
export const gameStateSchema = z.enum(["configuring", "active", "paused", "completed", "aborted"]);
export const gameResultSchema = z.enum(["*", "1-0", "0-1", "1/2-1/2"]);
export const drawReasonSchema = z.enum([
  "stalemate",
  "insufficient_material",
  "threefold_repetition",
  "fifty_move_rule",
]);
export const winReasonSchema = z.enum(["checkmate", "human_resignation", "model_technical_loss"]);
export const terminationReasonSchema = z.enum([
  ...winReasonSchema.options,
  ...drawReasonSchema.options,
  "aborted",
]);

// Exact end-of-input (including no trailing newline); legality is domain-owned.
export const uciMoveSchema = z
  .string()
  .regex(/^[a-h][1-8][a-h][1-8][qrbn]?(?![\s\S])/)
  .refine((move) => move.slice(0, 2) !== move.slice(2, 4));

export const gameIdSchema = z.uuid();
export const commandIdSchema = z.uuid();
/** Aggregate revision, not ply count. The application layer owns advancement. */
export const gameVersionSchema = z.number().int().nonnegative();

const unfinishedLifecycleSchema = z.strictObject({
  state: z.enum(["configuring", "active", "paused"]),
  result: z.literal("*"),
  terminationReason: z.null(),
});
const wonLifecycleSchema = z.strictObject({
  state: z.literal("completed"),
  result: z.enum(["1-0", "0-1"]),
  terminationReason: winReasonSchema,
});
const drawnLifecycleSchema = z.strictObject({
  state: z.literal("completed"),
  result: z.literal("1/2-1/2"),
  terminationReason: drawReasonSchema,
});
const abortedLifecycleSchema = z.strictObject({
  state: z.literal("aborted"),
  result: z.literal("*"),
  terminationReason: z.literal("aborted"),
});

export const gameLifecycleSchema = z.union([
  unfinishedLifecycleSchema,
  wonLifecycleSchema,
  drawnLifecycleSchema,
  abortedLifecycleSchema,
]);

/** The server supplies context; clients cannot choose a position or privileges. */
export const createGameRequestSchema = z.strictObject({});
export const guestSessionRequestSchema = z.strictObject({});
export const guestSessionResponseSchema = z.strictObject({ status: z.literal("ready") });
export const gameParamsSchema = z.strictObject({ gameId: gameIdSchema });
export const emptyQuerySchema = z.strictObject({});

export const moveRecordSchema = z.strictObject({
  ply: z.number().int().positive(),
  uci: uciMoveSchema,
  san: z.string().min(1),
  fen: z.string().min(1),
});

const invocationFields = {
  ply: z.number().int().positive(),
  color: chessColorSchema,
  /** Counts all calls for this ply across manual retries, including interrupted calls. */
  attempt: z.number().int().positive(),
  latencyMs: z.number().nonnegative().nullable(),
  usage: tokenUsageSchema,
};
const unacceptedFields = { accepted: z.literal(false), commentary: z.null() };

export const gameInvocationSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      ...invocationFields,
      status: z.literal("succeeded"),
      accepted: z.boolean(),
      commentary: z.string().max(2_000).nullable(),
      error: z.null(),
    })
    .refine((invocation) => invocation.accepted || invocation.commentary === null),
  z.strictObject({
    ...invocationFields,
    ...unacceptedFields,
    status: z.literal("model_invalid"),
    error: modelInvalidErrorSchema,
  }),
  z.strictObject({
    ...invocationFields,
    ...unacceptedFields,
    status: z.literal("provider_error"),
    error: providerErrorSchema,
  }),
  z.strictObject({
    ...invocationFields,
    ...unacceptedFields,
    status: z.enum(["pending", "abandoned"]),
    error: z.null(),
  }),
]);

const snapshotFields = {
  gameId: gameIdSchema,
  version: gameVersionSchema,
  fen: z.string().min(1),
  pgn: z.string().min(1),
  turn: chessColorSchema,
  inCheck: z.boolean(),
  legalMoves: z.array(uciMoveSchema),
  moves: z.array(moveRecordSchema),
  invocations: z.array(gameInvocationSchema).optional(),
};

export const gameSnapshotSchema = z
  .union([
    unfinishedLifecycleSchema.extend(snapshotFields),
    wonLifecycleSchema.extend(snapshotFields),
    drawnLifecycleSchema.extend(snapshotFields),
    abortedLifecycleSchema.extend(snapshotFields),
  ])
  .superRefine((snapshot, context) => {
    if (snapshot.state !== "active" && snapshot.legalMoves.length !== 0) {
      context.addIssue({ code: "custom", path: ["legalMoves"] });
    }
    if (snapshot.state === "configuring" && snapshot.moves.length !== 0) {
      context.addIssue({ code: "custom", path: ["moves"] });
    }
    snapshot.moves.forEach((move, index) => {
      if (move.ply !== index + 1) {
        context.addIssue({ code: "custom", path: ["moves", index, "ply"] });
      }
    });
    const acceptedPlies = new Set<number>();
    let previousPly = 0;
    let previousAttempt = 0;
    snapshot.invocations?.forEach((invocation, index) => {
      if (
        invocation.ply < previousPly ||
        invocation.ply > snapshot.moves.length + 1 ||
        invocation.color !== (invocation.ply % 2 === 1 ? "white" : "black") ||
        invocation.attempt !== (invocation.ply === previousPly ? previousAttempt + 1 : 1) ||
        (invocation.accepted &&
          (invocation.ply > snapshot.moves.length || acceptedPlies.has(invocation.ply)))
      ) {
        context.addIssue({ code: "custom", path: ["invocations", index] });
      }
      if (invocation.accepted) acceptedPlies.add(invocation.ply);
      previousPly = invocation.ply;
      previousAttempt = invocation.attempt;
    });
  });

export const moveCommandSchema = z.strictObject({
  gameId: gameIdSchema,
  move: uciMoveSchema,
  expectedVersion: gameVersionSchema,
  /** Reuse for retries of the same command; deduplication is application-owned. */
  commandId: commandIdSchema,
});

const commandFields = {
  gameId: gameIdSchema,
  expectedVersion: gameVersionSchema,
  commandId: commandIdSchema,
};

export const lifecycleCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...commandFields, action: z.literal("pause") }),
  z.strictObject({ ...commandFields, action: z.literal("resume") }),
  z.strictObject({ ...commandFields, action: z.literal("abort") }),
  z.strictObject({ ...commandFields, action: z.literal("resign"), losingColor: chessColorSchema }),
]);

export const unfinishedGameResponseSchema = z.strictObject({
  snapshot: gameSnapshotSchema
    .refine((snapshot) => snapshot.state === "active" || snapshot.state === "paused")
    .nullable(),
});

export const gameReplayResponseSchema = z.strictObject({
  snapshot: gameSnapshotSchema.refine(
    (snapshot) => snapshot.state === "completed" || snapshot.state === "aborted",
  ),
  initialFen: z.string().min(1),
});

export const gamePgnResponseSchema = z.strictObject({
  gameId: gameIdSchema,
  version: gameVersionSchema,
  pgn: z.string().min(1),
});

export const gameErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_UCI",
  "ILLEGAL_MOVE",
  "INVALID_GAME_STATE",
  "GAME_CONFLICT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INTERNAL_SERVER_ERROR",
]);

// Application-supplied safe display text preserves the existing error envelope.
// Only authorized conflict responses may carry a snapshot; no free-form details.
export const gameErrorResponseSchema = z.discriminatedUnion("code", [
  safeErrorResponseSchema.extend({ code: gameErrorCodeSchema.exclude(["GAME_CONFLICT"]) }),
  safeErrorResponseSchema.extend({
    code: z.literal("GAME_CONFLICT"),
    currentSnapshot: gameSnapshotSchema,
  }),
]);

export type ChessColor = z.infer<typeof chessColorSchema>;
export type GameState = z.infer<typeof gameStateSchema>;
export type GameResult = z.infer<typeof gameResultSchema>;
export type DrawReason = z.infer<typeof drawReasonSchema>;
export type WinReason = z.infer<typeof winReasonSchema>;
export type TerminationReason = z.infer<typeof terminationReasonSchema>;
export type UciMove = z.infer<typeof uciMoveSchema>;
export type GameId = z.infer<typeof gameIdSchema>;
export type CommandId = z.infer<typeof commandIdSchema>;
export type GameVersion = z.infer<typeof gameVersionSchema>;
export type GameLifecycle = z.infer<typeof gameLifecycleSchema>;
export type CreateGameRequest = z.infer<typeof createGameRequestSchema>;
export type GuestSessionResponse = z.infer<typeof guestSessionResponseSchema>;
export type MoveRecord = z.infer<typeof moveRecordSchema>;
export type GameInvocation = z.infer<typeof gameInvocationSchema>;
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
export type MoveCommand = z.infer<typeof moveCommandSchema>;
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;
export type UnfinishedGameResponse = z.infer<typeof unfinishedGameResponseSchema>;
export type GameReplayResponse = z.infer<typeof gameReplayResponseSchema>;
export type GamePgnResponse = z.infer<typeof gamePgnResponseSchema>;
export type GameErrorCode = z.infer<typeof gameErrorCodeSchema>;
export type GameErrorResponse = z.infer<typeof gameErrorResponseSchema>;
