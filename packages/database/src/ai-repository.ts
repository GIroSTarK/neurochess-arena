import { and, asc, count, desc, eq, gt, gte, sql } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseConnection } from "./client.js";
import {
  gameCommands,
  gameParticipants,
  games,
  guestSessions,
  modelInvocations,
  moves,
  turnReservations,
} from "./schema/index.js";

export type StoredTurnReservation = typeof turnReservations.$inferSelect;
export type StoredModelInvocation = typeof modelInvocations.$inferSelect;
type Executor = Pick<DatabaseConnection["db"], "select" | "insert" | "update">;

const identitySchema = z.strictObject({
  gameId: z.uuid(),
  ownerGuestSessionId: z.uuid(),
});
const leaseSchema = z.number().int().min(1).max(300_000);
const reservationRequestSchema = identitySchema.extend({
  commandId: z.uuid(),
  executorId: z.uuid(),
  expectedVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  color: z.enum(["white", "black"]),
  leaseMs: leaseSchema,
});
const reservationOwnerSchema = identitySchema.extend({
  reservationId: z.uuid(),
  executorId: z.uuid(),
});
export type ReserveAiTurn = z.infer<typeof reservationRequestSchema>;
export type AiReservationOwner = z.infer<typeof reservationOwnerSchema>;

const telemetrySchema = z.strictObject({
  latencyMs: z.number().nonnegative(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      totalTokens: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  providerRequestId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_.:-]+(?![\s\S])/)
    .optional(),
});
const invocationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: telemetrySchema.extend({
      move: z
        .string()
        .regex(/^[a-h][1-8][a-h][1-8][qrbn]?(?![\s\S])/)
        .refine((move) => move.slice(0, 2) !== move.slice(2, 4)),
      commentary: z.string().max(2_000).optional(),
    }),
  }),
  telemetrySchema.extend({
    ok: z.literal(false),
    error: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("model_invalid"),
        reason: z.enum(["malformed_output", "illegal_move"]),
      }),
      z.strictObject({
        kind: z.enum([
          "provider_auth",
          "provider_quota",
          "provider_timeout",
          "provider_unavailable",
        ]),
      }),
    ]),
  }),
]);
export type StoredInvocationResult = z.infer<typeof invocationResultSchema>;

export type AiReservationResult =
  | { status: "reserved"; reservation: StoredTurnReservation }
  | { status: "duplicate" | "conflict" | "busy" | "recovery_required" };

export interface AiTurnCommit {
  position: Pick<
    typeof games.$inferSelect,
    "state" | "result" | "terminationReason" | "fen" | "pgn" | "version"
  >;
  move?: Pick<typeof moves.$inferInsert, "ply" | "uci" | "san" | "fen">;
}

export interface AiReader {
  getTurnReservations(gameId: string): Promise<StoredTurnReservation[]>;
  getModelInvocations(gameId: string): Promise<StoredModelInvocation[]>;
}

export interface AiTransaction {
  reserveAiTurn(input: ReserveAiTurn): Promise<AiReservationResult>;
  renewAiTurn(owner: AiReservationOwner, leaseMs: number): Promise<void>;
  beginAiInvocation(owner: AiReservationOwner): Promise<StoredModelInvocation>;
  countAiInvalidOutputs(owner: AiReservationOwner): Promise<number>;
  recordAiInvocation(
    owner: AiReservationOwner,
    invocationId: string,
    result: StoredInvocationResult,
  ): Promise<void>;
  commitAiTurn(owner: AiReservationOwner, accepted: AiTurnCommit): Promise<void>;
}

export class AiPersistenceError extends Error {
  constructor(
    readonly code:
      | "INVALID_AI_DATA"
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "INVALID_AI_STATE"
      | "RESERVATION_LOST"
      | "AI_COMMAND_RESERVED",
  ) {
    super(code);
    this.name = "AiPersistenceError";
  }
}

function validated<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);
  // Validation diagnostics may contain attacker-controlled fields; retain only a fixed code.
  if (!parsed.success) throw new AiPersistenceError("INVALID_AI_DATA");
  return parsed.data;
}

export function aiReaderFor(db: Executor): AiReader {
  return {
    getTurnReservations: (gameId) =>
      db
        .select()
        .from(turnReservations)
        .where(eq(turnReservations.gameId, gameId))
        .orderBy(asc(turnReservations.expectedVersion)),
    getModelInvocations: (gameId) =>
      db
        .select()
        .from(modelInvocations)
        .where(eq(modelInvocations.gameId, gameId))
        .orderBy(asc(modelInvocations.startedAt), asc(modelInvocations.attempt)),
  };
}

export async function assertUnreservedCommand(db: Executor, gameId: string, commandId: string) {
  const [reserved] = await db
    .select({ id: turnReservations.id })
    .from(turnReservations)
    .where(and(eq(turnReservations.gameId, gameId), eq(turnReservations.commandId, commandId)));
  if (reserved) throw new AiPersistenceError("AI_COMMAND_RESERVED");
}

export async function invalidateAiReservations(db: Executor, gameId: string) {
  const invalidated = await db
    .update(turnReservations)
    .set({
      status: sql`case when ${turnReservations.leaseExpiresAt} <= clock_timestamp() then 'abandoned'::turn_reservation_status else 'cancelled'::turn_reservation_status end`,
      endedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(turnReservations.gameId, gameId), eq(turnReservations.status, "reserved")))
    .returning({ id: turnReservations.id });
  for (const reservation of invalidated) {
    await db
      .update(modelInvocations)
      .set({ status: "abandoned", finishedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(modelInvocations.reservationId, reservation.id),
          eq(modelInvocations.status, "pending"),
        ),
      );
  }
}

export function aiTransactionFor(db: Executor): AiTransaction {
  async function lockOwnerGame(identity: z.infer<typeof identitySchema>) {
    await db
      .select({ id: guestSessions.id })
      .from(guestSessions)
      .where(eq(guestSessions.id, identity.ownerGuestSessionId))
      .for("update");
    const [guest] = await db
      .select({ id: guestSessions.id })
      .from(guestSessions)
      .where(
        and(
          eq(guestSessions.id, identity.ownerGuestSessionId),
          gt(guestSessions.expiresAt, sql`clock_timestamp()`),
        ),
      );
    if (!guest) throw new AiPersistenceError("UNAUTHORIZED");
    const [game] = await db.select().from(games).where(eq(games.id, identity.gameId)).for("update");
    if (game?.ownerGuestSessionId !== identity.ownerGuestSessionId.toLowerCase()) {
      throw new AiPersistenceError("NOT_FOUND");
    }
    return game;
  }

  async function ownedReservation(input: AiReservationOwner) {
    const owner = validated(reservationOwnerSchema, input);
    const game = await lockOwnerGame(owner);
    const [reservation] = await db
      .select()
      .from(turnReservations)
      .where(
        and(
          eq(turnReservations.id, owner.reservationId),
          eq(turnReservations.gameId, game.id),
          eq(turnReservations.executorId, owner.executorId),
          eq(turnReservations.status, "reserved"),
          eq(turnReservations.expectedVersion, game.version),
          gt(turnReservations.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      );
    if (
      !reservation ||
      (game.state !== "active" && game.state !== "paused") ||
      game.isSandbox ||
      game.mode === "human_vs_human"
    ) {
      throw new AiPersistenceError("RESERVATION_LOST");
    }
    return { game, reservation };
  }

  async function lastInvocation(reservationId: string) {
    const [last] = await db
      .select()
      .from(modelInvocations)
      .where(eq(modelInvocations.reservationId, reservationId))
      .orderBy(desc(modelInvocations.attempt))
      .limit(1);
    return last;
  }

  async function invalidOutputCount(reservation: StoredTurnReservation) {
    const [lastMove] = await db
      .select({ version: moves.version })
      .from(moves)
      .where(eq(moves.gameId, reservation.gameId))
      .orderBy(desc(moves.version))
      .limit(1);
    // Lifecycle revisions and new reservations must not reset the current chess turn's budget.
    const [total] = await db
      .select({ value: count() })
      .from(turnReservations)
      .innerJoin(modelInvocations, eq(modelInvocations.reservationId, turnReservations.id))
      .where(
        and(
          eq(turnReservations.gameId, reservation.gameId),
          eq(turnReservations.color, reservation.color),
          gte(turnReservations.expectedVersion, lastMove?.version ?? 0),
          eq(modelInvocations.status, "model_invalid"),
        ),
      );
    return total?.value ?? 0;
  }

  async function assertLive(reservationId: string) {
    const [live] = await db
      .select({ id: turnReservations.id })
      .from(turnReservations)
      .where(
        and(
          eq(turnReservations.id, reservationId),
          gt(turnReservations.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      );
    if (!live) throw new AiPersistenceError("RESERVATION_LOST");
  }

  return {
    async reserveAiTurn(input) {
      const request = validated(reservationRequestSchema, input);
      const game = await lockOwnerGame(request);
      const [receipt] = await db
        .select({ commandId: gameCommands.commandId })
        .from(gameCommands)
        .where(
          and(eq(gameCommands.gameId, game.id), eq(gameCommands.commandId, request.commandId)),
        );
      const [duplicate] = await db
        .select({ id: turnReservations.id })
        .from(turnReservations)
        .where(
          and(
            eq(turnReservations.gameId, game.id),
            eq(turnReservations.commandId, request.commandId),
          ),
        );
      if (receipt || duplicate) return { status: "duplicate" };
      if (request.expectedVersion !== game.version) return { status: "conflict" };
      if (
        (game.state !== "active" && game.state !== "paused") ||
        game.isSandbox ||
        game.mode === "human_vs_human"
      ) {
        throw new AiPersistenceError("INVALID_AI_STATE");
      }
      const [pending] = await db
        .select({ live: sql<boolean>`${turnReservations.leaseExpiresAt} > clock_timestamp()` })
        .from(turnReservations)
        .where(and(eq(turnReservations.gameId, game.id), eq(turnReservations.status, "reserved")));
      if (pending) return { status: pending.live ? "busy" : "recovery_required" };
      const seats = await db
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, game.id));
      if (
        seats.length !== 2 ||
        seats.filter((seat) => seat.seatType === "ai").length !==
          (game.mode === "ai_vs_ai" ? 2 : 1) ||
        !seats.some((seat) => seat.color === request.color && seat.seatType === "ai")
      ) {
        throw new AiPersistenceError("INVALID_AI_STATE");
      }
      const [reservation] = await db
        .insert(turnReservations)
        .values({
          gameId: game.id,
          ownerGuestSessionId: game.ownerGuestSessionId,
          commandId: request.commandId,
          executorId: request.executorId,
          expectedVersion: request.expectedVersion,
          color: request.color,
          createdAt: sql`clock_timestamp()`,
          leaseExpiresAt: sql`clock_timestamp() + ${request.leaseMs} * interval '1 millisecond'`,
        })
        .returning();
      if (!reservation) throw new AiPersistenceError("INVALID_AI_STATE");
      await assertLive(reservation.id);
      return { status: "reserved", reservation };
    },
    async renewAiTurn(owner, leaseMs) {
      const duration = validated(leaseSchema, leaseMs);
      const { reservation } = await ownedReservation(owner);
      const renewed = await db
        .update(turnReservations)
        .set({ leaseExpiresAt: sql`clock_timestamp() + ${duration} * interval '1 millisecond'` })
        .where(
          and(
            eq(turnReservations.id, reservation.id),
            gt(turnReservations.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: turnReservations.id });
      if (renewed.length !== 1) throw new AiPersistenceError("RESERVATION_LOST");
    },
    async beginAiInvocation(owner) {
      const { reservation } = await ownedReservation(owner);
      const last = await lastInvocation(reservation.id);
      if (
        (last && (last.status !== "model_invalid" || last.attempt >= 3)) ||
        (await invalidOutputCount(reservation)) >= 3
      ) {
        throw new AiPersistenceError("INVALID_AI_STATE");
      }
      const [seat] = await db
        .select()
        .from(gameParticipants)
        .where(
          and(
            eq(gameParticipants.gameId, reservation.gameId),
            eq(gameParticipants.color, reservation.color),
            eq(gameParticipants.seatType, "ai"),
          ),
        );
      if (!seat) throw new AiPersistenceError("INVALID_AI_STATE");
      const [invocation] = await db
        .insert(modelInvocations)
        .values({
          reservationId: reservation.id,
          gameId: reservation.gameId,
          attempt: (last?.attempt ?? 0) + 1,
          provider: seat.provider,
          modelId: seat.modelId,
          temperature: seat.temperature,
          reasoningEffort: seat.reasoningEffort,
          maxOutputTokens: seat.maxOutputTokens,
          startedAt: sql`clock_timestamp()`,
        })
        .returning();
      if (!invocation) throw new AiPersistenceError("INVALID_AI_STATE");
      await assertLive(reservation.id);
      return invocation;
    },
    async countAiInvalidOutputs(owner) {
      const { reservation } = await ownedReservation(owner);
      return invalidOutputCount(reservation);
    },
    async recordAiInvocation(owner, invocationId, result) {
      const id = validated(z.uuid(), invocationId);
      const normalized = validated(invocationResultSchema, result);
      const { reservation } = await ownedReservation(owner);
      const telemetry = normalized.ok ? normalized.value : normalized;
      const error = normalized.ok ? null : normalized.error;
      const updated = await db
        .update(modelInvocations)
        .set({
          status: normalized.ok
            ? "succeeded"
            : error?.kind === "model_invalid"
              ? "model_invalid"
              : "provider_error",
          move: normalized.ok ? normalized.value.move : null,
          commentary: normalized.ok ? (normalized.value.commentary ?? null) : null,
          errorKind: error?.kind ?? null,
          invalidReason: error?.kind === "model_invalid" ? error.reason : null,
          latencyMs: telemetry.latencyMs,
          usageReported: telemetry.usage !== null,
          inputTokens: telemetry.usage?.inputTokens ?? null,
          outputTokens: telemetry.usage?.outputTokens ?? null,
          totalTokens: telemetry.usage?.totalTokens ?? null,
          providerRequestId: telemetry.providerRequestId ?? null,
          finishedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(modelInvocations.id, id),
            eq(modelInvocations.reservationId, reservation.id),
            eq(modelInvocations.status, "pending"),
          ),
        )
        .returning({ id: modelInvocations.id });
      if (updated.length !== 1) throw new AiPersistenceError("INVALID_AI_STATE");
      await assertLive(reservation.id);
    },
    async commitAiTurn(owner, accepted) {
      const { game, reservation } = await ownedReservation(owner);
      const last = await lastInvocation(reservation.id);
      const { position, move } = accepted;
      const kind =
        last?.status === "succeeded"
          ? "move"
          : last?.status === "provider_error"
            ? "pause"
            : "technical_loss";
      const validOutcome =
        kind === "move"
          ? move?.uci === last?.move &&
            move?.fen === position.fen &&
            (position.state === game.state || position.state === "completed")
          : !move &&
            position.fen === game.fen &&
            (kind === "pause"
              ? position.state === "paused" &&
                position.result === "*" &&
                position.terminationReason === null &&
                position.pgn === game.pgn
              : last?.status === "model_invalid" &&
                (await invalidOutputCount(reservation)) === 3 &&
                position.state === "completed" &&
                position.terminationReason === "model_technical_loss" &&
                position.result === (reservation.color === "white" ? "0-1" : "1-0"));
      if (!validOutcome || position.version !== game.version + 1) {
        throw new AiPersistenceError("INVALID_AI_STATE");
      }
      await db.insert(gameCommands).values({
        gameId: game.id,
        commandId: reservation.commandId,
        kind,
        version: position.version,
      });
      if (move) {
        await db.insert(moves).values({
          gameId: game.id,
          commandId: reservation.commandId,
          version: position.version,
          ply: move.ply,
          uci: move.uci,
          san: move.san,
          fen: move.fen,
        });
      }
      await db
        .update(games)
        .set({
          state: position.state,
          result: position.result,
          terminationReason: position.terminationReason,
          fen: position.fen,
          pgn: position.pgn,
          version: position.version,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(games.id, game.id));
      const committed = await db
        .update(turnReservations)
        .set({ status: "committed", endedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(turnReservations.id, reservation.id),
            gt(turnReservations.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: turnReservations.id });
      if (committed.length !== 1) throw new AiPersistenceError("RESERVATION_LOST");
    },
  };
}
