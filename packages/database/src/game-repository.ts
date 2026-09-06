import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import {
  type AiReader,
  aiReaderFor,
  type AiTransaction,
  aiTransactionFor,
  assertUnreservedCommand,
  invalidateAiReservations,
} from "./ai-repository.js";
import type { DatabaseConnection } from "./client.js";
import {
  gameCommands,
  gameParticipants,
  games,
  guestSessions,
  moves,
  turnReservations,
} from "./schema/index.js";

export type StoredGuestSession = typeof guestSessions.$inferSelect;
export type StoredGame = typeof games.$inferSelect;
export type StoredParticipant = typeof gameParticipants.$inferSelect;
export type StoredMove = typeof moves.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type NewParticipant = typeof gameParticipants.$inferInsert;
export type NewMove = typeof moves.$inferInsert;
export type NewGameCommand = typeof gameCommands.$inferInsert;
export type GamePositionUpdate = Pick<
  StoredGame,
  "state" | "result" | "terminationReason" | "fen" | "pgn" | "version"
>;

export interface GameReader extends AiReader {
  getGuest(id: string): Promise<StoredGuestSession | undefined>;
  getGame(id: string): Promise<StoredGame | undefined>;
  getParticipants(gameId: string): Promise<StoredParticipant[]>;
  getMoves(gameId: string): Promise<StoredMove[]>;
  findUnfinishedGame(guestId: string, sandboxOnly?: boolean): Promise<StoredGame | undefined>;
}

export interface GameTransaction extends GameReader, AiTransaction {
  lockGuest(id: string): Promise<StoredGuestSession | undefined>;
  lockGame(id: string): Promise<StoredGame | undefined>;
  hasCommand(gameId: string, commandId: string): Promise<boolean>;
  appendCommand(command: NewGameCommand): Promise<void>;
  insertGame(game: NewGame, participants: NewParticipant[]): Promise<void>;
  appendMove(move: NewMove): Promise<void>;
  updatePosition(
    gameId: string,
    expectedVersion: number,
    position: GamePositionUpdate,
  ): Promise<boolean>;
}

export interface GameRepository {
  createGuest(tokenHash: string, ttlSeconds: number): Promise<StoredGuestSession>;
  renewGuest(tokenHash: string, ttlSeconds: number): Promise<StoredGuestSession | undefined>;
  read<T>(action: (reader: GameReader) => Promise<T>): Promise<T>;
  write<T>(action: (transaction: GameTransaction) => Promise<T>): Promise<T>;
}

type Executor = Pick<DatabaseConnection["db"], "select" | "insert" | "update">;

function readerFor(db: Executor): GameReader {
  return {
    ...aiReaderFor(db),
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
    async findUnfinishedGame(guestId, sandboxOnly = false) {
      const [game] = await db
        .select()
        .from(games)
        .where(
          and(
            eq(games.ownerGuestSessionId, guestId),
            inArray(games.state, ["active", "paused"]),
            sandboxOnly ? eq(games.isSandbox, true) : undefined,
          ),
        );
      return game;
    },
  };
}

export function createGameRepository(connection: DatabaseConnection): GameRepository {
  const { db } = connection;
  return {
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
            ...aiTransactionFor(tx),
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
              if (receipt) return true;
              const [reserved] = await tx
                .select({ id: turnReservations.id })
                .from(turnReservations)
                .where(
                  and(
                    eq(turnReservations.gameId, gameId),
                    eq(turnReservations.commandId, commandId),
                  ),
                );
              return reserved !== undefined;
            },
            async appendCommand(command) {
              await assertUnreservedCommand(tx, command.gameId, command.commandId);
              await tx.insert(gameCommands).values(command);
            },
            async insertGame(game, participants) {
              await tx.insert(games).values(game);
              await tx.insert(gameParticipants).values(participants);
            },
            async appendMove(move) {
              await tx.insert(moves).values(move);
            },
            async updatePosition(gameId, expectedVersion, position) {
              const updated = await tx
                .update(games)
                .set({ ...position, updatedAt: sql`clock_timestamp()` })
                .where(and(eq(games.id, gameId), eq(games.version, expectedVersion)))
                .returning({ id: games.id });
              if (updated.length === 1) await invalidateAiReservations(tx, gameId);
              return updated.length === 1;
            },
          });
        },
        { isolationLevel: "read committed" },
      ),
  };
}
