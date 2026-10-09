import { z } from "zod";

import { gameIdSchema } from "./game.js";
import { roomViewSchema } from "./room.js";

export const roomClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    protocol: z.literal(1),
    type: z.literal("subscribe"),
    gameId: gameIdSchema,
    expectedIdentity: z.union([z.uuid(), z.literal("guest")]),
  }),
]);

export const roomServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ protocol: z.literal(1), type: z.literal("snapshot"), room: roomViewSchema }),
  z.strictObject({ protocol: z.literal(1), type: z.literal("update"), room: roomViewSchema }),
  z.strictObject({
    protocol: z.literal(1),
    type: z.literal("error"),
    code: z.enum(["INVALID_MESSAGE", "UNAVAILABLE"]),
  }),
  z.strictObject({ protocol: z.literal(1), type: z.literal("access_lost") }),
]);

export type RoomClientMessage = z.infer<typeof roomClientMessageSchema>;
export type RoomServerMessage = z.infer<typeof roomServerMessageSchema>;
