import { z } from "zod";

import { commandIdSchema, gameIdSchema, gameVersionSchema } from "./game.js";
import { aiParametersSchema, aiProviderSchema, modelIdSchema } from "./provider.js";

export const aiGameModeSchema = z.enum(["ai_vs_ai", "ai_vs_human"]);
export const humanSeatSchema = z.strictObject({ type: z.literal("human") });
export const aiSeatSchema = z.strictObject({
  type: z.literal("ai"),
  provider: aiProviderSchema,
  modelId: modelIdSchema,
  parameters: aiParametersSchema,
});
export const gameSeatSchema = z.discriminatedUnion("type", [humanSeatSchema, aiSeatSchema]);

// Color keys supply seat identity. Guest assignment is exclusively server-owned.
export const aiGameConfigurationSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("ai_vs_ai"),
    seats: z.strictObject({ white: aiSeatSchema, black: aiSeatSchema }),
  }),
  z.strictObject({
    mode: z.literal("ai_vs_human"),
    seats: z.union([
      z.strictObject({ white: humanSeatSchema, black: aiSeatSchema }),
      z.strictObject({ white: aiSeatSchema, black: humanSeatSchema }),
    ]),
  }),
]);

export const aiTurnCommandSchema = z.strictObject({
  gameId: gameIdSchema,
  expectedVersion: gameVersionSchema,
  commandId: commandIdSchema,
});

export const aiControlledTurnCommandSchema = aiTurnCommandSchema.extend({
  controllerId: z.uuid(),
  step: z.boolean().optional(),
});

export const aiControllerRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    gameId: gameIdSchema,
    controllerId: z.uuid(),
    action: z.literal("acquire"),
    expectedVersion: gameVersionSchema,
  }),
  z.strictObject({
    gameId: gameIdSchema,
    controllerId: z.uuid(),
    action: z.literal("heartbeat"),
  }),
]);

export type AiGameMode = z.infer<typeof aiGameModeSchema>;
export type AiSeat = z.infer<typeof aiSeatSchema>;
export type GameSeat = z.infer<typeof gameSeatSchema>;
export type AiGameConfiguration = z.infer<typeof aiGameConfigurationSchema>;
export type AiTurnCommand = z.infer<typeof aiTurnCommandSchema>;
export type AiControlledTurnCommand = z.infer<typeof aiControlledTurnCommandSchema>;
export type AiControllerRequest = z.infer<typeof aiControllerRequestSchema>;
