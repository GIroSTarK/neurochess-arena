import { and, asc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { removeAccountHistory } from "./account-removal.js";
import type { DatabaseConnection } from "./client.js";
import type { GamePositionUpdate, StoredGame, StoredMove } from "./game-records.js";
import type { StoredRoom } from "./room-repository.js";
import { gameCommands, gameParticipants, games, gameSlots, moves } from "./schema/index.js";
import { profiles } from "./schema/profiles.js";
import { rooms } from "./schema/rooms.js";
import { roomHistoryAccess } from "./schema/shared-history.js";
import { retainedRoomAccess } from "./shared-history-repository.js";

export type StoredParticipant = typeof gameParticipants.$inferSelect;
export type StoredHistoryGame = Pick<
  StoredGame,
  | "id"
  | "ownerUserId"
  | "ownerGuestSessionId"
  | "isSandbox"
  | "mode"
  | "state"
  | "result"
  | "terminationReason"
> & {
  finishedAt: string;
  participants: (StoredParticipant & { username: string | null })[];
  room: StoredRoom | undefined;
};
export type NewGame = typeof games.$inferInsert;
export type NewParticipant = typeof gameParticipants.$inferInsert;
export type NewMove = typeof moves.$inferInsert;
export type NewGameCommand = typeof gameCommands.$inferInsert;

const gameSlotReservationSchema = z.intersection(
  z.object({ gameId: z.uuid(), scope: z.enum(["ordinary", "sandbox"]) }),
  z.union([
    z.object({ userId: z.uuid(), guestSessionId: z.never().optional() }),
    z.object({ guestSessionId: z.uuid(), userId: z.never().optional() }),
  ]),
);
export type GameSlotReservation = z.infer<typeof gameSlotReservationSchema>;

export interface GameStateReader {
  findAccountHistory(
    userId: string,
    limit: number,
    before?: { finishedAt: string; gameId: string },
  ): Promise<StoredHistoryGame[]>;
  getGame(id: string): Promise<StoredGame | undefined>;
  getParticipants(gameId: string): Promise<StoredParticipant[]>;
  getMoves(gameId: string): Promise<StoredMove[]>;
  findUnfinishedGame(
    guestId: string,
    scope: "ordinary" | "sandbox",
  ): Promise<StoredGame | undefined>;
  findUnfinishedAccountGame(userId: string): Promise<StoredGame | undefined>;
}

export interface GameStateTransaction extends GameStateReader {
  // Call under the requester's identity lock and the appropriate game/room write protocol.
  reserveGameSlot(reservation: GameSlotReservation): Promise<void>;
  releaseGameSlots(gameId: string): Promise<void>;
  deleteAccountHistory(userId: string, gameId?: string): Promise<void>;
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

type Executor = Pick<
  DatabaseConnection["db"],
  "select" | "insert" | "update" | "delete" | "execute"
>;

export function gameStateReaderFor(db: Pick<Executor, "select">): GameStateReader {
  return {
    async findAccountHistory(userId, limit, before) {
      const records = await db
        .select({
          id: games.id,
          ownerUserId: games.ownerUserId,
          ownerGuestSessionId: games.ownerGuestSessionId,
          isSandbox: games.isSandbox,
          mode: games.mode,
          state: games.state,
          result: games.result,
          terminationReason: games.terminationReason,
          finishedAt: sql<string>`to_char(${games.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(games)
        .where(
          and(
            eq(games.isSandbox, false),
            or(
              and(eq(games.ownerUserId, userId), inArray(games.mode, ["ai_vs_ai", "ai_vs_human"])),
              and(eq(games.mode, "human_vs_human"), exists(retainedRoomAccess(db, userId))),
            ),
            inArray(games.state, ["completed", "aborted"]),
            before
              ? sql`(${games.updatedAt}, ${games.id}) < (${before.finishedAt}::timestamptz, ${before.gameId}::uuid)`
              : undefined,
          ),
        )
        .orderBy(sql`${games.updatedAt} desc nulls last`, sql`${games.id} desc nulls last`)
        .limit(limit);
      if (records.length === 0) return [];
      const participants = await db
        .select({ participant: gameParticipants, username: profiles.username })
        .from(gameParticipants)
        .leftJoin(profiles, eq(profiles.userId, gameParticipants.userId))
        .where(
          inArray(
            gameParticipants.gameId,
            records.map((game) => game.id),
          ),
        );
      const roomRecords = await db
        .select()
        .from(rooms)
        .where(
          inArray(
            rooms.gameId,
            records.map((game) => game.id),
          ),
        );
      const roomById = new Map(roomRecords.map((room) => [room.gameId, room]));
      const seats = new Map<string, StoredHistoryGame["participants"]>();
      for (const { participant, username } of participants) {
        const group = seats.get(participant.gameId) ?? [];
        group.push({ ...participant, username });
        seats.set(participant.gameId, group);
      }
      return records.map((game) => ({
        ...game,
        participants: seats.get(game.id) ?? [],
        room: roomById.get(game.id),
      }));
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
    async findUnfinishedGame(guestId, scope) {
      const [game] = await db
        .select({ game: games })
        .from(games)
        .innerJoin(gameSlots, eq(gameSlots.gameId, games.id))
        .where(
          and(
            eq(gameSlots.guestSessionId, guestId),
            inArray(games.state, ["active", "paused"]),
            eq(gameSlots.scope, scope),
          ),
        );
      return game?.game;
    },
    async findUnfinishedAccountGame(userId) {
      const [game] = await db
        .select({ game: games })
        .from(games)
        .innerJoin(gameSlots, eq(gameSlots.gameId, games.id))
        .where(
          and(
            eq(gameSlots.userId, userId),
            inArray(games.state, ["active", "paused"]),
            eq(gameSlots.scope, "ordinary"),
          ),
        );
      return game?.game;
    },
  };
}

export function gameStateTransactionFor(tx: Executor): GameStateTransaction {
  const reader = gameStateReaderFor(tx);
  async function reserveGameSlot(input: GameSlotReservation) {
    const reservation = gameSlotReservationSchema.parse(input);
    const game = await reader.getGame(reservation.gameId);
    if (
      !game ||
      !["active", "paused"].includes(game.state) ||
      game.isSandbox !== (reservation.scope === "sandbox")
    ) {
      throw new Error("Game slot requires an unfinished game in the matching scope");
    }
    await tx.insert(gameSlots).values(reservation);
  }
  async function releaseGameSlots(gameId: string) {
    await tx.delete(gameSlots).where(eq(gameSlots.gameId, gameId));
  }

  return {
    ...reader,
    reserveGameSlot,
    releaseGameSlots,
    async deleteAccountHistory(userId, gameId) {
      await removeAccountHistory(tx, userId, gameId);
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
      const [created] = await tx.insert(games).values(game).returning();
      if (!created) throw new Error("Game insertion failed");
      if (participants.length) await tx.insert(gameParticipants).values(participants);
      if (created.mode === "human_vs_human") {
        const accounts = participants.flatMap((seat) =>
          seat.userId ? [{ gameId: created.id, userId: seat.userId }] : [],
        );
        if (accounts.length) await tx.insert(roomHistoryAccess).values(accounts);
      }
      if (created.state === "active" || created.state === "paused") {
        const scope = created.isSandbox ? "sandbox" : "ordinary";
        const identities = new Map<string, GameSlotReservation>();
        for (const identity of [
          { userId: created.ownerUserId, guestSessionId: created.ownerGuestSessionId },
          ...participants,
        ]) {
          if (identity.userId) {
            identities.set(`account:${identity.userId}`, {
              gameId: created.id,
              scope,
              userId: identity.userId,
            });
          }
          if (identity.guestSessionId) {
            identities.set(`guest:${identity.guestSessionId}`, {
              gameId: created.id,
              scope,
              guestSessionId: identity.guestSessionId,
            });
          }
        }
        for (const reservation of identities.values()) await reserveGameSlot(reservation);
      }
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
      if (
        updated.length === 1 &&
        (position.state === "completed" || position.state === "aborted")
      ) {
        await releaseGameSlots(gameId);
      }
      return updated.length === 1;
    },
  };
}
