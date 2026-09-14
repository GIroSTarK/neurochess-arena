import { z } from "zod";

import { gameSnapshotSchema } from "./game.js";
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

export const gameDetailsSchema = z.strictObject({
  snapshot: gameSnapshotSchema,
  // Legacy games, including Sandbox, have no ordinary AI configuration.
  configuration: aiGameConfigurationSchema.nullable(),
});
export const unfinishedGameDetailsSchema = z.strictObject({
  game: gameDetailsSchema
    .refine(({ snapshot }) => snapshot.state === "active" || snapshot.state === "paused")
    .nullable(),
});

export type AiGameMode = z.infer<typeof aiGameModeSchema>;
export type AiSeat = z.infer<typeof aiSeatSchema>;
export type GameSeat = z.infer<typeof gameSeatSchema>;
export type AiGameConfiguration = z.infer<typeof aiGameConfigurationSchema>;
export type GameDetails = z.infer<typeof gameDetailsSchema>;
export type UnfinishedGameDetails = z.infer<typeof unfinishedGameDetailsSchema>;
