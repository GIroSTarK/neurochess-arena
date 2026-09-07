import { z } from "zod";

import { aiConfigurationSchema, modelCatalogIdSchema, sessionCredentialSchema } from "./ai.js";
import {
  chessColorSchema,
  commandIdSchema,
  gameIdSchema,
  gameSnapshotSchema,
  gameVersionSchema,
} from "./game.js";

export const aiRuntimeHeader = "x-neurochess-ai-runtime";
export const aiRuntimeIdSchema = z.uuid();

const aiSelectionSchema = aiConfigurationSchema.extend({
  catalogId: modelCatalogIdSchema.optional(),
});

export const aiGameConfigurationSchema = z.discriminatedUnion("mode", [
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

export const createAiGameRequestSchema = z.discriminatedUnion("mode", [
  aiGameConfigurationSchema.options[0].extend({
    white: aiSelectionSchema,
    black: aiSelectionSchema,
  }),
  aiGameConfigurationSchema.options[1].extend({ ai: aiSelectionSchema }),
]);

export const aiGameResponseSchema = z.strictObject({
  snapshot: gameSnapshotSchema,
  configuration: aiGameConfigurationSchema,
});

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
export type AiGameConfiguration = z.infer<typeof aiGameConfigurationSchema>;
export type AiGameResponse = z.infer<typeof aiGameResponseSchema>;
export type AiTurnCommand = z.infer<typeof aiTurnCommandSchema>;
export type AiTurnRequest = z.infer<typeof aiTurnRequestSchema>;
