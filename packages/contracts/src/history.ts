import { z } from "zod";

import { aiGameConfigurationSchema } from "./ai-game.js";
import {
  gameIdSchema,
  gameLifecycleSchema,
  gameResultSchema,
  terminationReasonSchema,
} from "./game.js";

export const historyTimestampSchema = z.iso
  .datetime({ precision: 6 })
  .refine((value) => !value.startsWith("0000"));
// Preserve PostgreSQL microseconds: JavaScript Date would lose pagination boundaries.
export const gameHistoryCursorSchema = z
  .string()
  .max(64)
  .refine((value) => {
    const parts = value.split("_");
    return (
      parts.length === 2 &&
      historyTimestampSchema.safeParse(parts[0]).success &&
      gameIdSchema.safeParse(parts[1]).success
    );
  });
export const gameHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: gameHistoryCursorSchema.optional(),
});
export const gameHistoryEntrySchema = z
  .strictObject({
    gameId: gameIdSchema,
    finishedAt: historyTimestampSchema,
    configuration: aiGameConfigurationSchema,
    state: z.enum(["completed", "aborted"]),
    result: gameResultSchema,
    terminationReason: terminationReasonSchema,
  })
  .superRefine((entry, context) => {
    if (
      !gameLifecycleSchema.safeParse({
        state: entry.state,
        result: entry.result,
        terminationReason: entry.terminationReason,
      }).success
    ) {
      context.addIssue({ code: "custom", path: ["state"] });
    }
  });
export const gameHistoryResponseSchema = z.strictObject({
  games: z.array(gameHistoryEntrySchema).max(50),
  nextCursor: gameHistoryCursorSchema.nullable(),
});
export const gameDeleteRequestSchema = z.strictObject({
  gameId: gameIdSchema,
  confirm: z.literal(true),
});
export const gameHistoryClearRequestSchema = z.strictObject({ confirm: z.literal(true) });
export const gameHistoryDeletedResponseSchema = z.strictObject({ status: z.literal("deleted") });
export type GameHistoryDeletedResponse = z.infer<typeof gameHistoryDeletedResponseSchema>;
export type GameHistoryQuery = z.infer<typeof gameHistoryQuerySchema>;
export type GameHistoryEntry = z.infer<typeof gameHistoryEntrySchema>;
export type GameHistoryResponse = z.infer<typeof gameHistoryResponseSchema>;
