import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { aiControllers, aiTurnReservations, aiTurns, modelInvocations } from "./schema/index.js";

export type StoredAiTurnReservation = typeof aiTurnReservations.$inferSelect;
export type StoredAiTurn = typeof aiTurns.$inferSelect;
export type StoredModelInvocation = typeof modelInvocations.$inferSelect;
export type NewModelInvocation = Pick<
  StoredModelInvocation,
  | "turnId"
  | "reservationId"
  | "commandId"
  | "expectedVersion"
  | "provider"
  | "modelId"
  | "effectiveParameters"
  | "pricingVersion"
  | "pricingSource"
  | "pricingCheckedAt"
  | "pricingRates"
  | "pricingUnavailableReason"
>;
export type InvocationResult = Pick<
  StoredModelInvocation,
  | "outcome"
  | "errorCode"
  | "errorReason"
  | "durationMs"
  | "usageReported"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "commentary"
  | "billingUsage"
  | "costAmount"
  | "costUnavailableReason"
>;
export type NewAiTurnReservation = Pick<
  StoredAiTurnReservation,
  "gameId" | "reservationId" | "commandId" | "expectedVersion"
>;

export interface AiExecutionReader {
  getAiTurns(gameId: string): Promise<StoredAiTurn[]>;
  getModelInvocations(gameId: string): Promise<StoredModelInvocation[]>;
}

export interface AiExecutionTransaction extends AiExecutionReader {
  getAiController(
    gameId: string,
  ): Promise<{ controllerId: string | null; expired: boolean } | undefined>;
  setAiController(gameId: string, controllerId: string | null, leaseMs: number): Promise<void>;
  renewAiController(gameId: string, controllerId: string, leaseMs: number): Promise<boolean>;
  clearAiController(gameId: string): Promise<void>;
  getAiTurnReservation(gameId: string): Promise<StoredAiTurnReservation | undefined>;
  reserveAiTurn(reservation: NewAiTurnReservation): Promise<void>;
  blockAiTurn(gameId: string, reservationId: string): Promise<void>;
  // Interrupts pending attempts and removes the reservation, preserving the logical turn and budget.
  invalidateAiExecution(gameId: string): Promise<void>;
  getOrCreateAiTurn(turn: Pick<StoredAiTurn, "gameId" | "ply" | "color">): Promise<StoredAiTurn>;
  beginModelInvocation(invocation: NewModelInvocation): Promise<StoredModelInvocation>;
  finishModelInvocation(
    id: string,
    reservationId: string,
    result: InvocationResult,
    allowInterrupted?: boolean,
  ): Promise<boolean>;
  incrementAiInvalidCount(turnId: string): Promise<number>;
  linkAiTurnMove(turnId: string, ply: number): Promise<void>;
}

type Executor = Pick<DatabaseConnection["db"], "select" | "insert" | "update" | "delete">;

export function aiExecutionReaderFor(db: Pick<Executor, "select">): AiExecutionReader {
  return {
    getAiTurns: (gameId) =>
      db.select().from(aiTurns).where(eq(aiTurns.gameId, gameId)).orderBy(asc(aiTurns.ply)),
    getModelInvocations: (gameId) =>
      db
        .select()
        .from(modelInvocations)
        .where(
          inArray(
            modelInvocations.turnId,
            db.select({ id: aiTurns.id }).from(aiTurns).where(eq(aiTurns.gameId, gameId)),
          ),
        )
        .orderBy(asc(modelInvocations.attemptNumber)),
  };
}

export function aiExecutionTransactionFor(tx: Executor): AiExecutionTransaction {
  return {
    ...aiExecutionReaderFor(tx),
    async getAiController(gameId) {
      const [lease] = await tx
        .select({
          controllerId: aiControllers.controllerId,
          expired: sql<boolean>`${aiControllers.expiresAt} <= clock_timestamp()`,
        })
        .from(aiControllers)
        .where(eq(aiControllers.gameId, gameId));
      return lease;
    },
    async setAiController(gameId, controllerId, leaseMs) {
      const expiresAt = sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`;
      await tx
        .insert(aiControllers)
        .values({ gameId, controllerId, expiresAt })
        .onConflictDoUpdate({
          target: aiControllers.gameId,
          set: { controllerId, expiresAt },
        });
    },
    async renewAiController(gameId, controllerId, leaseMs) {
      const rows = await tx
        .update(aiControllers)
        .set({
          expiresAt: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
        })
        .where(
          and(
            eq(aiControllers.gameId, gameId),
            eq(aiControllers.controllerId, controllerId),
            gt(aiControllers.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ gameId: aiControllers.gameId });
      return rows.length === 1;
    },
    async clearAiController(gameId) {
      await tx.delete(aiControllers).where(eq(aiControllers.gameId, gameId));
    },
    async getAiTurnReservation(gameId) {
      const [reservation] = await tx
        .select()
        .from(aiTurnReservations)
        .where(eq(aiTurnReservations.gameId, gameId));
      return reservation;
    },
    async reserveAiTurn(reservation) {
      await tx.insert(aiTurnReservations).values(reservation);
    },
    async blockAiTurn(gameId, reservationId) {
      await tx
        .update(aiTurnReservations)
        .set({ state: "blocked" })
        .where(
          and(
            eq(aiTurnReservations.gameId, gameId),
            eq(aiTurnReservations.reservationId, reservationId),
          ),
        );
    },
    async invalidateAiExecution(gameId) {
      await tx
        .update(modelInvocations)
        .set({ outcome: "interrupted" })
        .where(
          and(
            inArray(
              modelInvocations.reservationId,
              tx
                .select({ id: aiTurnReservations.reservationId })
                .from(aiTurnReservations)
                .where(eq(aiTurnReservations.gameId, gameId)),
            ),
            eq(modelInvocations.outcome, "in_flight"),
          ),
        );
      await tx.delete(aiTurnReservations).where(eq(aiTurnReservations.gameId, gameId));
    },
    async getOrCreateAiTurn(turn) {
      const [existing] = await tx
        .select()
        .from(aiTurns)
        .where(and(eq(aiTurns.gameId, turn.gameId), eq(aiTurns.ply, turn.ply)));
      if (existing) return existing;
      const [created] = await tx.insert(aiTurns).values(turn).returning();
      if (!created) throw new Error("AI turn insertion failed");
      return created;
    },
    async beginModelInvocation(invocation) {
      const [turn] = await tx
        .update(aiTurns)
        .set({ attemptCount: sql`${aiTurns.attemptCount} + 1` })
        .where(eq(aiTurns.id, invocation.turnId))
        .returning();
      if (!turn) throw new Error("AI turn missing");
      const [attempt] = await tx
        .insert(modelInvocations)
        .values({
          ...invocation,
          attemptNumber: turn.attemptCount,
          costUnavailableReason: "dispatch_unknown",
        })
        .returning();
      if (!attempt) throw new Error("Invocation insertion failed");
      return attempt;
    },
    async finishModelInvocation(id, reservationId, result, allowInterrupted = false) {
      const rows = await tx
        .update(modelInvocations)
        .set(result)
        .where(
          and(
            eq(modelInvocations.id, id),
            eq(modelInvocations.reservationId, reservationId),
            inArray(
              modelInvocations.outcome,
              allowInterrupted ? ["in_flight", "interrupted"] : ["in_flight"],
            ),
          ),
        )
        .returning({ id: modelInvocations.id });
      return rows.length === 1;
    },
    async incrementAiInvalidCount(turnId) {
      const [turn] = await tx
        .update(aiTurns)
        .set({ invalidOutputCount: sql`${aiTurns.invalidOutputCount} + 1` })
        .where(and(eq(aiTurns.id, turnId), lt(aiTurns.invalidOutputCount, 3)))
        .returning();
      if (!turn) throw new Error("AI retry budget exhausted");
      return turn.invalidOutputCount;
    },
    async linkAiTurnMove(turnId, ply) {
      await tx.update(aiTurns).set({ acceptedMovePly: ply }).where(eq(aiTurns.id, turnId));
    },
  };
}
