import { z } from "zod";

import { aiGameModeSchema } from "./ai-game.js";
import {
  gameIdSchema,
  gameLifecycleSchema,
  gameResultSchema,
  terminationReasonSchema,
} from "./game.js";
import { usernameSchema } from "./profile.js";
import { aiProviderSchema, modelIdSchema } from "./provider.js";

const finishedAtSchema = z.iso.datetime({ precision: 6 });
export const gameHistoryCursorSchema = z
  .string()
  .length(64)
  .refine((cursor) => {
    const [finishedAt, gameId] = cursor.split("/");
    return finishedAtSchema.safeParse(finishedAt).success && gameIdSchema.safeParse(gameId).success;
  });

export const gameHistoryQuerySchema = z.strictObject({
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[1-9]\d?$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(50))
    .default(20),
  cursor: gameHistoryCursorSchema.optional(),
});

const playerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("human"), username: usernameSchema.nullable() }),
  z.strictObject({ type: z.literal("ai"), provider: aiProviderSchema, modelId: modelIdSchema }),
]);

export const gameHistoryItemSchema = z
  .strictObject({
    gameId: gameIdSchema,
    finishedAt: finishedAtSchema,
    mode: aiGameModeSchema,
    players: z.strictObject({ white: playerSchema, black: playerSchema }),
    state: z.enum(["completed", "aborted"]),
    result: gameResultSchema,
    terminationReason: terminationReasonSchema,
  })
  .refine(
    ({ state, result, terminationReason }) =>
      gameLifecycleSchema.safeParse({ state, result, terminationReason }).success,
  )
  .refine(({ mode, players }) =>
    mode === "ai_vs_ai"
      ? players.white.type === "ai" && players.black.type === "ai"
      : players.white.type !== players.black.type,
  );

export const gameHistoryPageSchema = z.strictObject({
  games: z.array(gameHistoryItemSchema).max(50),
  nextCursor: gameHistoryCursorSchema.nullable(),
});

export const gameDeletionRequestSchema = z.strictObject({ confirm: z.literal(true) });
export const gameDeletionResponseSchema = z.strictObject({ success: z.literal(true) });

export type GameHistoryQuery = z.infer<typeof gameHistoryQuerySchema>;
export type GameHistoryItem = z.infer<typeof gameHistoryItemSchema>;
export type GameHistoryPage = z.infer<typeof gameHistoryPageSchema>;
