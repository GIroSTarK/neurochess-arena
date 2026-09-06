import { z } from "zod";

import { aiConfigurationSchema, sessionCredentialSchema } from "./ai.js";
import { chessColorSchema, commandIdSchema, gameIdSchema, gameVersionSchema } from "./game.js";

export const createAiGameRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("ai_vs_ai"),
    white: aiConfigurationSchema,
    black: aiConfigurationSchema,
  }),
  z.strictObject({
    mode: z.literal("ai_vs_human"),
    humanColor: chessColorSchema,
    ai: aiConfigurationSchema,
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
