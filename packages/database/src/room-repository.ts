import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseConnection } from "./client.js";
import { user } from "./schema/auth.js";
import { gameParticipants } from "./schema/games.js";
import { roomCreationOperations, rooms } from "./schema/rooms.js";
import { roomHistoryAccess } from "./schema/shared-history.js";
import { lockSharedRooms } from "./shared-history-repository.js";

export type StoredRoom = typeof rooms.$inferSelect;
export type StoredRoomCreationOperation = typeof roomCreationOperations.$inferSelect;
type Executor = Pick<DatabaseConnection["db"], "select" | "insert" | "update" | "execute">;

const newRoomSchema = z.strictObject({
  gameId: z.uuid(),
  ownerColor: z.enum(["white", "black"]),
  state: z.enum(["waiting", "joined"]),
  invitationDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
  joinedAt: z.date().nullable().optional(),
});
const newOperationSchema = z.strictObject({
  userId: z.uuid(),
  operationId: z.uuid(),
  issuedAt: z.date(),
  expiresAt: z.date(),
  state: z.enum(["pending", "consumed"]),
  ownerColor: z.enum(["white", "black"]).nullable().optional(),
  gameId: z.uuid().nullable().optional(),
});

export interface RoomReader {
  isVerifiedRoomAccount(userId: string): Promise<boolean>;
  findRoomInvitation(digest: string): Promise<StoredRoom | undefined>;
  findRoomJoin(commandId: string): Promise<StoredRoom | undefined>;
  getLiveRoomCreationOperation(
    userId: string,
    operationId: string,
  ): Promise<StoredRoomCreationOperation | undefined>;
  hasRetainedRoomAccess(gameId: string, userId: string): Promise<boolean>;
  getRoom(gameId: string): Promise<StoredRoom | undefined>;
  getRoomCreationOperation(userId: string): Promise<StoredRoomCreationOperation | undefined>;
}
export interface RoomTransaction extends RoomReader {
  issueRoomCreationOperation(
    userId: string,
    operationId: string,
  ): Promise<StoredRoomCreationOperation>;
  consumeRoomCreationOperation(
    userId: string,
    ownerColor: "white" | "black",
    gameId: string,
  ): Promise<void>;
  setRoomInvitation(gameId: string, digest: string | null): Promise<void>;
  acceptRoomJoin(gameId: string, commandId: string, digest: string): Promise<void>;
  lockSharedRooms(): Promise<void>;
  seatRoomParticipant(
    gameId: string,
    color: "white" | "black",
    identity: { userId: string } | { guestSessionId: string },
  ): Promise<void>;
  insertRoom(room: z.input<typeof newRoomSchema>): Promise<void>;
  insertRoomCreationOperation(operation: z.input<typeof newOperationSchema>): Promise<void>;
}

export function roomReaderFor(db: Executor): RoomReader {
  return {
    async isVerifiedRoomAccount(userId) {
      const [account] = await db
        .select({ verified: user.emailVerified })
        .from(user)
        .where(eq(user.id, userId));
      return account?.verified === true;
    },
    async findRoomInvitation(digest) {
      const [room] = await db.select().from(rooms).where(eq(rooms.invitationDigest, digest));
      return room;
    },
    async findRoomJoin(commandId) {
      const [room] = await db.select().from(rooms).where(eq(rooms.joinCommandId, commandId));
      return room;
    },
    async getLiveRoomCreationOperation(userId, operationId) {
      const [operation] = await db
        .select()
        .from(roomCreationOperations)
        .where(
          and(
            eq(roomCreationOperations.userId, userId),
            eq(roomCreationOperations.operationId, operationId),
            gt(roomCreationOperations.expiresAt, sql`clock_timestamp()`),
          ),
        );
      return operation;
    },
    async hasRetainedRoomAccess(gameId, userId) {
      const [access] = await db
        .select({ gameId: roomHistoryAccess.gameId })
        .from(roomHistoryAccess)
        .where(and(eq(roomHistoryAccess.gameId, gameId), eq(roomHistoryAccess.userId, userId)));
      return access !== undefined;
    },
    async getRoom(gameId) {
      const [room] = await db.select().from(rooms).where(eq(rooms.gameId, gameId));
      return room;
    },
    async getRoomCreationOperation(userId) {
      const [operation] = await db
        .select()
        .from(roomCreationOperations)
        .where(eq(roomCreationOperations.userId, userId));
      return operation;
    },
  };
}

export function roomTransactionFor(db: Executor): RoomTransaction {
  return {
    ...roomReaderFor(db),
    lockSharedRooms: () => lockSharedRooms(db),
    async issueRoomCreationOperation(userId, operationId) {
      const values = {
        userId,
        operationId,
        issuedAt: sql`statement_timestamp()`,
        expiresAt: sql`statement_timestamp() + interval '10 minutes'`,
        state: "pending" as const,
        ownerColor: null,
        gameId: null,
      };
      const [operation] = await db
        .insert(roomCreationOperations)
        .values(values)
        .onConflictDoUpdate({ target: roomCreationOperations.userId, set: values })
        .returning();
      if (!operation) throw new Error("Room operation issuance failed");
      return operation;
    },
    async consumeRoomCreationOperation(userId, ownerColor, gameId) {
      await db
        .update(roomCreationOperations)
        .set({ state: "consumed", ownerColor, gameId })
        .where(eq(roomCreationOperations.userId, userId));
    },
    async setRoomInvitation(gameId, digest) {
      await db.update(rooms).set({ invitationDigest: digest }).where(eq(rooms.gameId, gameId));
    },
    async acceptRoomJoin(gameId, commandId, digest) {
      await db
        .update(rooms)
        .set({
          state: "joined",
          joinedAt: sql`clock_timestamp()`,
          invitationDigest: null,
          joinCommandId: commandId,
          joinedInvitationDigest: digest,
        })
        .where(eq(rooms.gameId, gameId));
    },
    async seatRoomParticipant(gameId, color, input) {
      const identity = z
        .union([z.strictObject({ userId: z.uuid() }), z.strictObject({ guestSessionId: z.uuid() })])
        .parse(input);
      const seated = await db
        .update(gameParticipants)
        .set(identity)
        .where(
          and(
            eq(gameParticipants.gameId, gameId),
            eq(gameParticipants.color, color),
            eq(gameParticipants.seatType, "human"),
            isNull(gameParticipants.userId),
            isNull(gameParticipants.guestSessionId),
          ),
        )
        .returning({ id: gameParticipants.id });
      if (seated.length !== 1) throw new Error("Room seat is unavailable");
      if ("userId" in identity) {
        await db.insert(roomHistoryAccess).values({ gameId, userId: identity.userId });
      }
    },
    async insertRoom(input) {
      await db.insert(rooms).values(newRoomSchema.parse(input));
    },
    async insertRoomCreationOperation(input) {
      await db.insert(roomCreationOperations).values(newOperationSchema.parse(input));
    },
  };
}
