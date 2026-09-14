import { z } from "zod";

import { chessColorSchema, commandIdSchema, gameIdSchema, gameVersionSchema } from "./game.js";
import {
  aiParametersSchema,
  aiProviderSchema,
  modelIdSchema,
  providerFailureSchema,
  tokenUsageSchema,
} from "./provider.js";

export const invocationOutcomeSchema = z.enum([
  "in_flight",
  "accepted",
  "model_invalid",
  "provider_error",
  "interrupted",
  "discarded",
]);

export const modelInvocationSchema = z
  .strictObject({
    id: z.uuid(),
    attemptNumber: z.number().int().positive(),
    commandId: commandIdSchema,
    expectedVersion: gameVersionSchema,
    provider: aiProviderSchema,
    modelId: modelIdSchema,
    effectiveParameters: aiParametersSchema,
    outcome: invocationOutcomeSchema,
    error: providerFailureSchema.nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    usage: tokenUsageSchema.nullable(),
    commentary: z.string().max(2000).nullable(),
  })
  .refine((attempt) => {
    if (attempt.outcome === "in_flight" || attempt.outcome === "interrupted") {
      return (
        attempt.error === null &&
        attempt.durationMs === null &&
        attempt.usage === null &&
        attempt.commentary === null
      );
    }
    if (attempt.durationMs === null) return false;
    if (attempt.outcome === "accepted") return attempt.error === null;
    if (attempt.commentary !== null) return false;
    if (attempt.outcome === "model_invalid") return attempt.error?.code === "model_invalid";
    if (attempt.outcome === "provider_error") {
      return attempt.error !== null && attempt.error.code !== "model_invalid";
    }
    return true;
  });

export const aiTurnRecordSchema = z
  .strictObject({
    id: z.uuid(),
    ply: z.number().int().positive(),
    color: chessColorSchema,
    invalidOutputCount: z.number().int().min(0).max(3),
    acceptedMovePly: z.number().int().positive().nullable(),
    attempts: z.array(modelInvocationSchema),
  })
  .refine(
    (turn) =>
      turn.color === (turn.ply % 2 === 1 ? "white" : "black") &&
      (turn.acceptedMovePly === null || turn.acceptedMovePly === turn.ply) &&
      (turn.acceptedMovePly === null ||
        (turn.invalidOutputCount < 3 && turn.attempts.at(-1)?.outcome === "accepted")) &&
      turn.attempts.filter((attempt) => attempt.outcome === "in_flight").length <= 1 &&
      turn.attempts.every((attempt, index) => attempt.attemptNumber === index + 1) &&
      turn.attempts.filter((attempt) => attempt.outcome === "model_invalid").length ===
        turn.invalidOutputCount &&
      turn.attempts.filter((attempt) => attempt.outcome === "accepted").length ===
        (turn.acceptedMovePly === null ? 0 : 1),
  );

export const gameInvocationsSchema = z.strictObject({
  gameId: gameIdSchema,
  version: gameVersionSchema,
  turns: z.array(aiTurnRecordSchema),
});

export type ModelInvocation = z.infer<typeof modelInvocationSchema>;
export type AiTurnRecord = z.infer<typeof aiTurnRecordSchema>;
export type GameInvocations = z.infer<typeof gameInvocationsSchema>;
