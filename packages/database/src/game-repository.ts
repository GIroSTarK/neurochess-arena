import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  type AiExecutionReader,
  aiExecutionReaderFor,
  type AiExecutionTransaction,
  aiExecutionTransactionFor,
} from "./ai-execution-repository.js";
import {
  type AnalysisReader,
  analysisReaderFor,
  type AnalysisTransaction,
  analysisTransactionFor,
} from "./analysis-repository.js";
import type { DatabaseConnection } from "./client.js";
import { type CredentialReader, credentialReaderFor } from "./credential-access-repository.js";
import {
  type GameStateReader,
  gameStateReaderFor,
  type GameStateTransaction,
  gameStateTransactionFor,
} from "./game-state-repository.js";
import {
  type IdentityReader,
  identityReaderFor,
  type IdentityTransaction,
  identityTransactionFor,
  type StoredGuestSession,
} from "./identity-repository.js";
import { hasCurrentRoomAccess, type RoomAccessIdentity } from "./room-access.js";
import {
  type RoomReader,
  roomReaderFor,
  type RoomTransaction,
  roomTransactionFor,
} from "./room-repository.js";
import { aiControllers, games, guestSessions } from "./schema/index.js";
import { cleanupSharedRooms } from "./shared-history-repository.js";

export type { GamePositionUpdate, StoredGame, StoredMove } from "./game-records.js";
export type { StoredGuestSession } from "./identity-repository.js";
export type {
  StoredParticipant,
  StoredHistoryGame,
  NewGame,
  NewParticipant,
  NewMove,
  NewGameCommand,
  GameSlotReservation,
} from "./game-state-repository.js";
export type {
  StoredAiTurnReservation,
  StoredAiTurn,
  StoredModelInvocation,
  NewModelInvocation,
  InvocationResult,
  NewAiTurnReservation,
} from "./ai-execution-repository.js";

export interface GameReader
  extends
    IdentityReader,
    GameStateReader,
    AiExecutionReader,
    CredentialReader,
    RoomReader,
    AnalysisReader {}
export interface GameTransaction
  extends
    GameReader,
    IdentityTransaction,
    GameStateTransaction,
    AiExecutionTransaction,
    RoomTransaction,
    AnalysisTransaction {}
export interface GameRepository {
  hasCurrentRoomAccess(gameId: string, identity: RoomAccessIdentity): Promise<boolean>;
  cleanupSharedRooms(): Promise<void>;
  expiredAiControllers(): Promise<
    { gameId: string; ownerGuestSessionId: string | null; ownerUserId: string | null }[]
  >;
  createGuest(tokenHash: string, ttlSeconds: number): Promise<StoredGuestSession>;
  renewGuest(tokenHash: string, ttlSeconds: number): Promise<StoredGuestSession | undefined>;
  read<T>(action: (reader: GameReader) => Promise<T>): Promise<T>;
  write<T>(action: (transaction: GameTransaction) => Promise<T>): Promise<T>;
}

function readerFor(
  db: Pick<DatabaseConnection["db"], "select" | "insert" | "update" | "execute">,
): GameReader {
  return {
    ...identityReaderFor(db),
    ...gameStateReaderFor(db),
    ...aiExecutionReaderFor(db),
    ...credentialReaderFor(db),
    ...roomReaderFor(db),
    ...analysisReaderFor(db),
  };
}

export function createGameRepository(connection: DatabaseConnection): GameRepository {
  const { db } = connection;
  return {
    cleanupSharedRooms: () => cleanupSharedRooms(connection),
    hasCurrentRoomAccess: (gameId, identity) => hasCurrentRoomAccess(connection, gameId, identity),
    expiredAiControllers: () =>
      db
        .select({
          gameId: games.id,
          ownerGuestSessionId: games.ownerGuestSessionId,
          ownerUserId: games.ownerUserId,
        })
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
        .limit(100),
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
      return db.transaction(async (tx) => {
        await tx
          .select({ id: guestSessions.id })
          .from(guestSessions)
          .where(eq(guestSessions.tokenHash, tokenHash))
          .for("update");
        // An UPDATE can evaluate its clock predicate before a row wait. Lock first,
        // then check expiry in a fresh statement shared with terminal room cleanup.
        const [guest] = await tx
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
      });
    },
    read: (action) =>
      db.transaction((tx) => action(readerFor(tx)), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }),
    write: (action) =>
      db.transaction(
        async (tx) =>
          action({
            ...identityTransactionFor(tx),
            ...gameStateTransactionFor(tx),
            ...aiExecutionTransactionFor(tx),
            ...credentialReaderFor(tx),
            ...roomTransactionFor(tx),
            ...analysisReaderFor(tx),
            ...analysisTransactionFor(tx),
          }),
        { isolationLevel: "read committed" },
      ),
  };
}
