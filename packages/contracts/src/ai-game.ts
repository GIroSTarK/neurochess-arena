import { z } from "zod";

import { aiConfigurationSchema, modelCatalogIdSchema, sessionCredentialSchema } from "./ai.js";
import { chessColorSchema, commandIdSchema, gameIdSchema, gameVersionSchema } from "./game.js";

const aiSelectionSchema = aiConfigurationSchema.extend({
  catalogId: modelCatalogIdSchema.optional(),
});

export const createAiGameRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("ai_vs_ai"),
    white: aiSelectionSchema,
    black: aiSelectionSchema,
  }),
  z.strictObject({
    mode: z.literal("ai_vs_human"),
    humanColor: chessColorSchema,
    ai: aiSelectionSchema,
  }),
]);

// The service derives the seat, configuration, and chess context from persisted state.
export const aiTurnCommandSchema = z.strictObject({
  gameId: gameIdSchema,
  expectedVersion: gameVersionSchema,
  commandId: commandIdSchema,
});

export const aiTurnRequestSchema = aiTurnCommandSchema.extend({
  credential: sessionCredentialSchema,
});

export type CreateAiGameRequest = z.infer<typeof createAiGameRequestSchema>;
export type AiTurnCommand = z.infer<typeof aiTurnCommandSchema>;
export type AiTurnRequest = z.infer<typeof aiTurnRequestSchema>;
