import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

import { hasAccountSession, lockAccountSession } from "./account-session.js";
import type { DatabaseConnection } from "./client.js";
import { readProviderCredential } from "./credential-repository.js";
import {
  type HistoryBoundary,
  readAccountHistory,
  type StoredHistoryGame,
} from "./history-repository.js";
import {
  aiControllers,
  aiTurnReservations,
  aiTurns,
  gameCommands,
  gameParticipants,
  games,
  guestSessions,
  modelInvocations,
  moves,
  profiles,
  user,
} from "./schema/index.js";

export type StoredGuestSession = typeof guestSessions.$inferSelect;
export type StoredGame = typeof games.$inferSelect;
export type StoredParticipant = typeof gameParticipants.$inferSelect;
export type StoredMove = typeof moves.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type NewParticipant = typeof gameParticipants.$inferInsert;
export type NewMove = typeof moves.$inferInsert;
export type NewGameCommand = typeof gameCommands.$inferInsert;
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
>;
export type NewAiTurnReservation = Pick<
  StoredAiTurnReservation,
  "gameId" | "reservationId" | "commandId" | "expectedVersion"
>;
export type GamePositionUpdate = Pick<
  StoredGame,
  "state" | "result" | "terminationReason" | "fen" | "pgn" | "version"
>;

export type GameOwner =
  | { readonly kind: "guest"; readonly guestSessionId: string }
  | { readonly kind: "account"; readonly userId: string };

export interface GameReader {
  accountHistory(
    userId: string,
    limit: number,
    cursor?: HistoryBoundary,
  ): Promise<StoredHistoryGame[]>;
  getGuest(id: string): Promise<StoredGuestSession | undefined>;
  hasAccountSession(userId: string, sessionId: string): Promise<boolean>;
  hasCompletedProfile(userId: string): Promise<boolean>;
  getGame(id: string): Promise<StoredGame | undefined>;
  getParticipants(gameId: string): Promise<StoredParticipant[]>;
  getMoves(gameId: string): Promise<StoredMove[]>;
  getAiTurns(gameId: string): Promise<StoredAiTurn[]>;
  getModelInvocations(gameId: string): Promise<StoredModelInvocation[]>;
  findUnfinishedGame(
    owner: GameOwner,
    scope: "ordinary" | "sandbox",
  ): Promise<StoredGame | undefined>;
}

export interface GameTransaction extends GameReader {
  getProviderCredential(
    userId: string,
    id: string,
    provider: NonNullable<StoredParticipant["provider"]>,
  ): ReturnType<typeof readProviderCredential>;
  getAiController(
    gameId: string,
  ): Promise<{ controllerId: string | null; expired: boolean } | undefined>;
  setAiController(gameId: string, controllerId: string | null, leaseMs: number): Promise<void>;
  renewAiController(gameId: string, controllerId: string, leaseMs: number): Promise<boolean>;
  clearAiController(gameId: string): Promise<void>;
  lockGuest(id: string): Promise<StoredGuestSession | undefined>;
  lockAccount(userId: string): Promise<void>;
  lockAccountSession(userId: string, sessionId: string): Promise<boolean>;
  lockGame(id: string): Promise<StoredGame | undefined>;
  hasCommand(gameId: string, commandId: string): Promise<boolean>;
  appendCommand(command: NewGameCommand): Promise<void>;
  insertGame(game: NewGame, participants: NewParticipant[]): Promise<void>;
  appendMove(move: NewMove): Promise<void>;
  getAiTurnReservation(gameId: string): Promise<StoredAiTurnReservation | undefined>;
  reserveAiTurn(reservation: NewAiTurnReservation): Promise<void>;
  blockAiTurn(gameId: string, reservationId: string): Promise<void>;
  clearAiTurn(gameId: string): Promise<void>;
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
  updatePosition(
    gameId: string,
    expectedVersion: number,
    position: GamePositionUpdate,
  ): Promise<boolean>;
}

export interface GameRepository {
  expiredAiControllers(): Promise<{ gameId: string; owner: GameOwner }[]>;
  createGuest(tokenHash: string, ttlSeconds: number): Promise<StoredGuestSession>;
  renewGuest(tokenHash: string, ttlSeconds: number): Promise<StoredGuestSession | undefined>;
  read<T>(action: (reader: GameReader) => Promise<T>): Promise<T>;
  write<T>(action: (transaction: GameTransaction) => Promise<T>): Promise<T>;
}

type Executor = Pick<DatabaseConnection["db"], "select" | "insert" | "update">;

function readerFor(db: Executor): GameReader {
  return {
    accountHistory: (userId, limit, cursor) => readAccountHistory(db, userId, limit, cursor),
    hasAccountSession: (userId, sessionId) => hasAccountSession(db, userId, sessionId),
    async hasCompletedProfile(userId) {
      const [profile] = await db
        .select({ id: profiles.userId })
        .from(profiles)
        .where(and(eq(profiles.userId, userId), isNotNull(profiles.username)));
      return profile !== undefined;
    },
    async getGuest(id) {
      const [guest] = await db
        .select()
        .from(guestSessions)
        .where(and(eq(guestSessions.id, id), gt(guestSessions.expiresAt, sql`clock_timestamp()`)));
      return guest;
    },
    async getGame(id) {
      const [game] = await db.select().from(games).where(eq(games.id, id));
      return game;
    },
    getParticipants: (gameId) =>
      db
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, gameId))
        .orderBy(asc(gameParticipants.color)),
    getMoves: (gameId) =>
      db.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(asc(moves.ply)),
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
    async findUnfinishedGame(owner, scope) {
      const [game] = await db
        .select()
        .from(games)
        .where(
          and(
            owner.kind === "guest"
              ? eq(games.ownerGuestSessionId, owner.guestSessionId)
              : eq(games.ownerUserId, owner.userId),
            inArray(games.state, ["active", "paused"]),
            eq(games.isSandbox, scope === "sandbox"),
          ),
        );
      return game;
    },
  };
}

export function createGameRepository(connection: DatabaseConnection): GameRepository {
  const { db } = connection;
  return {
    async expiredAiControllers() {
      const candidates = await db
        .select({ gameId: games.id, guestId: games.ownerGuestSessionId, userId: games.ownerUserId })
        .from(games)
        .leftJoin(aiControllers, eq(aiControllers.gameId, games.id))
        .where(
          and(
            inArray(games.mode, ["ai_vs_ai", "ai_vs_human"]),
            or(
              lte(aiControllers.expiresAt, sql`clock_timestamp()`),
              and(eq(games.state, "active"), isNull(aiControllers.gameId)),
            ),
          ),
        )
        .orderBy(asc(games.updatedAt))
        .limit(100);
      return candidates.map(({ gameId, guestId, userId }) => {
        if (guestId !== null) {
          return { gameId, owner: { kind: "guest" as const, guestSessionId: guestId } };
        }
        if (userId !== null) return { gameId, owner: { kind: "account" as const, userId } };
        throw new Error("Game owner missing");
      });
    },
    async createGuest(tokenHash, ttlSeconds) {
      const [guest] = await db
        .insert(guestSessions)
        .values({
          tokenHash,
          expiresAt: sql`clock_timestamp() + ${ttlSeconds} * interval '1 second'`,
        })
        .returning();
      if (!guest) throw new Error("Guest insertion failed");
      return guest;
    },
    async renewGuest(tokenHash, ttlSeconds) {
      const [guest] = await db
        .update(guestSessions)
        .set({
          lastSeenAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp() + ${ttlSeconds} * interval '1 second'`,
        })
        .where(
          and(
            eq(guestSessions.tokenHash, tokenHash),
            gt(guestSessions.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning();
      return guest;
    },
    read: (action) =>
      db.transaction((tx) => action(readerFor(tx)), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }),
    write: (action) =>
      db.transaction(
        async (tx) => {
          const reader = readerFor(tx);
          return action({
            ...reader,
            getProviderCredential: (userId, id, provider) =>
              readProviderCredential(tx, userId, id, provider),
            async lockAccount(userId) {
              await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
            },
            lockAccountSession: (userId, sessionId) => lockAccountSession(tx, userId, sessionId),
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
            async lockGuest(id) {
              await tx
                .select({ id: guestSessions.id })
                .from(guestSessions)
                .where(eq(guestSessions.id, id))
                .for("update");
              // Check expiry after any lock wait, using the database clock.
              return reader.getGuest(id);
            },
            async lockGame(id) {
              const [game] = await tx.select().from(games).where(eq(games.id, id)).for("update");
              return game;
            },
            async hasCommand(gameId, commandId) {
              const [receipt] = await tx
                .select({ commandId: gameCommands.commandId })
                .from(gameCommands)
                .where(and(eq(gameCommands.gameId, gameId), eq(gameCommands.commandId, commandId)));
              return receipt !== undefined;
            },
            async appendCommand(command) {
              await tx.insert(gameCommands).values(command);
            },
            async insertGame(game, participants) {
              await tx.insert(games).values(game);
              await tx.insert(gameParticipants).values(participants);
            },
            async appendMove(move) {
              await tx.insert(moves).values(move);
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
            async clearAiTurn(gameId) {
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
                .values({ ...invocation, attemptNumber: turn.attemptCount })
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
            async updatePosition(gameId, expectedVersion, position) {
              const updated = await tx
                .update(games)
                .set({ ...position, updatedAt: sql`clock_timestamp()` })
                .where(and(eq(games.id, gameId), eq(games.version, expectedVersion)))
                .returning({ id: games.id });
              return updated.length === 1;
            },
          });
        },
        { isolationLevel: "read committed" },
      ),
  };
}
