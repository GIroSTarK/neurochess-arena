import type { AiExecutionTransaction, GameStateTransaction } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { lockIdentity } from "../identity/validity.js";

import { type AiAttemptState, invocationResult } from "./ai-turn-outcome.js";
import { AiTurnError, GameConflictError, GameRequestError } from "./errors.js";

export async function recoverAiExecution(
  tx: Parameters<typeof lockIdentity>[0] &
    Pick<GameStateTransaction, "lockGame"> &
    Pick<AiExecutionTransaction, "finishModelInvocation" | "blockAiTurn">,
  principal: Principal,
  gameId: string,
  reservationId: string,
  attemptState: AiAttemptState,
  error: unknown,
) {
  // Cleanup uses the server's attempt/fence identity, even if the principal has expired.
  await lockIdentity(tx, principal);
  await tx.lockGame(gameId);
  if (
    attemptState.kind === "received" &&
    (error instanceof GameConflictError ||
      error instanceof GameRequestError ||
      (error instanceof AiTurnError && error.code === "AI_CONTROLLER_LOST"))
  ) {
    await tx.finishModelInvocation(
      attemptState.attempt.id,
      reservationId,
      invocationResult(attemptState.response, attemptState.attempt, true),
      true,
    );
  }
  await tx.blockAiTurn(gameId, reservationId);
}
