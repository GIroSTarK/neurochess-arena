import { type GameDetails, gameInvocationsSchema } from "@neurochess/contracts";

import { GAME_ID, snapshot } from "./fixtures";

export const telemetryDetails = {
  snapshot: snapshot(["e2e4", "e7e5"]),
  configuration: {
    mode: "ai_vs_ai",
    seats: {
      white: { type: "ai", provider: "openai", modelId: "fixture-white", parameters: {} },
      black: { type: "ai", provider: "anthropic", modelId: "fixture-black", parameters: {} },
    },
  },
} satisfies GameDetails;
export const viewerCommentary = '<img src=x onerror="alert(1)"> **Viewer note**';

export function invocationRecords() {
  const attempt = {
    commandId: crypto.randomUUID(),
    expectedVersion: 0,
    provider: "openai",
    modelId: "fixture-white",
    effectiveParameters: {},
    error: null,
    commentary: null,
    usage: null,
  };
  return gameInvocationsSchema.parse({
    gameId: GAME_ID,
    version: 2,
    turns: [
      {
        id: crypto.randomUUID(),
        ply: 1,
        color: "white",
        invalidOutputCount: 1,
        acceptedMovePly: 1,
        attempts: [
          {
            ...attempt,
            id: crypto.randomUUID(),
            attemptNumber: 1,
            outcome: "model_invalid",
            error: { code: "model_invalid", reason: "illegal_move" },
            durationMs: 100,
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: null },
          },
          {
            ...attempt,
            id: crypto.randomUUID(),
            attemptNumber: 2,
            outcome: "provider_error",
            error: { code: "provider_quota" },
            durationMs: 200,
          },
          {
            ...attempt,
            id: crypto.randomUUID(),
            attemptNumber: 3,
            outcome: "accepted",
            durationMs: 300,
            commentary: viewerCommentary,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        ply: 2,
        color: "black",
        invalidOutputCount: 0,
        acceptedMovePly: 2,
        attempts: [
          {
            ...attempt,
            id: crypto.randomUUID(),
            attemptNumber: 1,
            outcome: "accepted",
            provider: "anthropic",
            modelId: "fixture-black",
            durationMs: 400,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 20 },
          },
        ],
      },
    ],
  });
}
