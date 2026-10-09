import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseConnection } from "./client.js";
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
  hasRetainedRoomAccess(gameId: string, userId: string): Promise<boolean>;
  getRoom(gameId: string): Promise<StoredRoom | undefined>;
  getRoomCreationOperation(userId: string): Promise<StoredRoomCreationOperation | undefined>;
}
export interface RoomTransaction extends RoomReader {
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
