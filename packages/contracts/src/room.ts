import { z } from "zod";

import { humanSeatSchema } from "./ai-game.js";
import {
  chessColorSchema,
  commandIdSchema,
  gameErrorResponseSchema,
  gameIdSchema,
  gameSnapshotSchema,
  gameVersionSchema,
} from "./game.js";
import { humanPlayerSchema } from "./game-player.js";
import { safeErrorResponseSchema } from "./system.js";

// Seat identities and admission are assigned by the server, never by configuration.
export const humanGameConfigurationSchema = z.strictObject({
  mode: z.literal("human_vs_human"),
  seats: z.strictObject({ white: humanSeatSchema, black: humanSeatSchema }),
});

export type HumanGameConfiguration = z.infer<typeof humanGameConfigurationSchema>;

// The last character excludes noncanonical encodings of the same 32 random bytes.
export const roomInvitationSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048](?![\s\S])/);
export const roomCreationOperationRequestSchema = z.strictObject({});
export const roomCreationOperationSchema = z.strictObject({
  operationId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export const createRoomRequestSchema = z.strictObject({
  operationId: z.uuid(),
  ownerColor: chessColorSchema,
});
export const roomResolutionRequestSchema = z.strictObject({ invitation: roomInvitationSchema });
export const roomResolutionSchema = z.strictObject({ status: z.enum(["joinable", "unavailable"]) });
export const roomJoinRequestSchema = z.strictObject({
  invitation: roomInvitationSchema,
  commandId: commandIdSchema,
});
export const roomInvitationRequestSchema = z.strictObject({
  gameId: gameIdSchema,
  commandId: commandIdSchema,
  expectedVersion: gameVersionSchema,
  action: z.enum(["replace", "revoke"]),
});
export const roomViewSchema = z.strictObject({
  snapshot: gameSnapshotSchema,
  ownerColor: chessColorSchema,
  state: z.enum(["waiting", "joined"]),
  invitationAvailable: z.boolean(),
  players: z.strictObject({ white: humanPlayerSchema, black: humanPlayerSchema }),
  viewer: z.strictObject({ color: chessColorSchema, isOwner: z.boolean() }),
  capabilities: z.strictObject({
    canMove: z.boolean(),
    canResign: z.boolean(),
    canClose: z.boolean(),
    canManageInvitation: z.boolean(),
  }),
});
export const roomIssuedResponseSchema = z.strictObject({
  room: roomViewSchema,
  invitation: roomInvitationSchema.nullable(),
});
export const roomErrorCodeSchema = z.enum([
  "ROOM_OPERATION_UNAVAILABLE",
  "ROOM_OPERATION_CONFLICT",
  "ROOM_UNAVAILABLE",
  "ROOM_SELF_JOIN",
  "ROOM_ACCOUNT_UNVERIFIED",
  "RATE_LIMITED",
]);
export const roomErrorResponseSchema = z.union([
  safeErrorResponseSchema.extend({ code: roomErrorCodeSchema }),
  gameErrorResponseSchema,
]);

export type RoomCreationOperation = z.infer<typeof roomCreationOperationSchema>;
export type RoomView = z.infer<typeof roomViewSchema>;
export type RoomIssuedResponse = z.infer<typeof roomIssuedResponseSchema>;
export type RoomResolution = z.infer<typeof roomResolutionSchema>;
export type RoomErrorCode = z.infer<typeof roomErrorCodeSchema>;
