import {
  type GameInvocations,
  gameInvocationsSchema,
  type GameSnapshot,
} from "@neurochess/contracts";
import type { AiExecutionReader, StoredModelInvocation } from "@neurochess/database";

import { readBilling, readCost } from "../pricing/persistence.js";

import { GameIntegrityError } from "./errors.js";

export async function readInvocations(
  reader: AiExecutionReader,
  snapshot: GameSnapshot,
): Promise<GameInvocations> {
  const turns = await reader.getAiTurns(snapshot.gameId);
  const attempts = await reader.getModelInvocations(snapshot.gameId);
  const byTurn = new Map<string, StoredModelInvocation[]>();
  for (const attempt of attempts) {
    const group = byTurn.get(attempt.turnId) ?? [];
    group.push(attempt);
    byTurn.set(attempt.turnId, group);
  }
  const result = gameInvocationsSchema.safeParse({
    gameId: snapshot.gameId,
    version: snapshot.version,
    turns: turns.map((turn) => {
      const invocations = byTurn.get(turn.id) ?? [];
      if (invocations.length !== turn.attemptCount || turn.ply > snapshot.moves.length + 1) {
        throw new GameIntegrityError();
      }
      return {
        id: turn.id,
        ply: turn.ply,
        color: turn.color,
        invalidOutputCount: turn.invalidOutputCount,
        acceptedMovePly: turn.acceptedMovePly,
        attempts: invocations.map((attempt) => ({
          id: attempt.id,
          attemptNumber: attempt.attemptNumber,
          commandId: attempt.commandId,
          expectedVersion: attempt.expectedVersion,
          provider: attempt.provider,
          modelId: attempt.modelId,
          effectiveParameters: attempt.effectiveParameters,
          outcome: attempt.outcome,
          error:
            attempt.errorCode === null
              ? null
              : {
                  code: attempt.errorCode,
                  ...(attempt.errorReason === null ? {} : { reason: attempt.errorReason }),
                },
          durationMs: attempt.durationMs,
          usage: attempt.usageReported
            ? {
                inputTokens: attempt.inputTokens,
                outputTokens: attempt.outputTokens,
                totalTokens: attempt.totalTokens,
              }
            : null,
          commentary: attempt.commentary,
          billing: readBilling(attempt.billingUsage),
          cost: readCost(attempt),
        })),
      };
    }),
  });
  if (!result.success) throw new GameIntegrityError();
  return result.data;
}
