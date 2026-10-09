import { z } from "zod";

import { aiGameConfigurationSchema, type AiGameMode } from "./ai-game.js";
import { gameSnapshotSchema } from "./game.js";
import { humanGameConfigurationSchema } from "./room.js";

export const gameConfigurationSchema = z.discriminatedUnion("mode", [
  ...aiGameConfigurationSchema.options,
  humanGameConfigurationSchema,
]);

export const gameDetailsSchema = z.strictObject({
  snapshot: gameSnapshotSchema,
  // Null retains the original meaning for legacy games and Sandbox.
  configuration: gameConfigurationSchema.nullable(),
});
export const unfinishedGameDetailsSchema = z.strictObject({
  game: gameDetailsSchema
    .refine(({ snapshot }) => snapshot.state === "active" || snapshot.state === "paused")
    .nullable(),
});

export function isAiGameMode(mode: unknown): mode is AiGameMode {
  return mode === "ai_vs_ai" || mode === "ai_vs_human";
}

export type GameConfiguration = z.infer<typeof gameConfigurationSchema>;
export type GameDetails = z.infer<typeof gameDetailsSchema>;
export type UnfinishedGameDetails = z.infer<typeof unfinishedGameDetailsSchema>;
