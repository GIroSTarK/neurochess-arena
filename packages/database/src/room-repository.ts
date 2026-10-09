import { eq } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseConnection } from "./client.js";
import { roomCreationOperations, rooms } from "./schema/rooms.js";

export type StoredRoom = typeof rooms.$inferSelect;
export type StoredRoomCreationOperation = typeof roomCreationOperations.$inferSelect;
type Executor = Pick<DatabaseConnection["db"], "select" | "insert">;

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
  getRoom(gameId: string): Promise<StoredRoom | undefined>;
  getRoomCreationOperation(userId: string): Promise<StoredRoomCreationOperation | undefined>;
}
export interface RoomTransaction extends RoomReader {
  insertRoom(room: z.input<typeof newRoomSchema>): Promise<void>;
  insertRoomCreationOperation(operation: z.input<typeof newOperationSchema>): Promise<void>;
}

export function roomReaderFor(db: Executor): RoomReader {
  return {
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
    async insertRoom(input) {
      await db.insert(rooms).values(newRoomSchema.parse(input));
    },
    async insertRoomCreationOperation(input) {
      await db.insert(roomCreationOperations).values(newOperationSchema.parse(input));
    },
  };
}
