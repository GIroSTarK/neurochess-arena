import type { ChessGame } from "@neurochess/chess";
import type { AiControlledTurnCommand, NormalizedMoveResponse } from "@neurochess/contracts";
import type {
  AiExecutionTransaction,
  InvocationResult,
  StoredModelInvocation,
} from "@neurochess/database";

import { observe, type Operations } from "../monitoring/operations.js";
import { calculateCost } from "../pricing/calculator.js";
import { readBilling, storedPricing } from "../pricing/persistence.js";
import { cancellationFailure } from "../providers/transport.js";

import { type ClassifiedAiResponse, decideAiOutcome } from "./ai-outcome-policy.js";
import type { RecheckedAiExecution, ReservedAiExecution } from "./ai-turn-reservation.js";
import { persistCommand } from "./command-persistence.js";
import { GameIntegrityError } from "./errors.js";

export interface ReceivedAiAttempt {
  readonly kind: "received";
  readonly attempt: StoredModelInvocation;
  readonly response: NormalizedMoveResponse;
}

export type AiAttemptState =
  | { readonly kind: "none" }
  | { readonly kind: "inFlight"; readonly attempt: StoredModelInvocation }
  | ReceivedAiAttempt;

function classifyAiResponse(
  received: NormalizedMoveResponse,
  executionGame: ChessGame,
  signal: AbortSignal,
  operations?: Operations,
): ClassifiedAiResponse {
  let response = received;
  if (response.ok && !executionGame.snapshot().legalMoves.includes(response.output.move)) {
    response = {
      ...response,
      ok: false,
      error: { code: "model_invalid", reason: "illegal_move" },
    };
    observe(operations, (sink) => sink.increment("modelInvalid"));
  }
  if (response.ok && signal.aborted) {
    response = { ...response, ok: false, error: cancellationFailure(signal) };
  }
  if (response.ok) return { kind: "legal", response };
  return {
    kind: response.error.code === "model_invalid" ? "invalid" : "providerFailure",
    response,
  };
}

export function invocationResult(
  response: NormalizedMoveResponse,
  attempt: StoredModelInvocation,
  discarded = false,
): InvocationResult {
  const error = response.ok ? null : response.error;
  const billingUsage = readBilling(response.billing);
  const cost = calculateCost(storedPricing(attempt), billingUsage);
  return {
    outcome: discarded
      ? "discarded"
      : response.ok
        ? "accepted"
        : error?.code === "model_invalid"
          ? "model_invalid"
          : "provider_error",
    errorCode: error?.code ?? null,
    errorReason: error && "reason" in error ? error.reason : null,
    durationMs: response.durationMs,
    usageReported: response.usage !== null,
    inputTokens: response.usage?.inputTokens ?? null,
    outputTokens: response.usage?.outputTokens ?? null,
    totalTokens: response.usage?.totalTokens ?? null,
    billingUsage,
    costAmount: cost.status === "estimated" ? cost.amount : null,
    costUnavailableReason: cost.status === "unavailable" ? cost.reason : null,
    commentary: response.ok && !discarded ? (response.output.commentary ?? null) : null,
  };
}

export async function commitAiAttempt(
  tx: Parameters<typeof persistCommand>[0] &
    Pick<
      AiExecutionTransaction,
      "finishModelInvocation" | "incrementAiInvalidCount" | "linkAiTurnMove"
    >,
  options: {
    readonly command: AiControlledTurnCommand;
    readonly reserved: ReservedAiExecution;
    readonly execution: RecheckedAiExecution;
    readonly received: ReceivedAiAttempt;
    readonly signal: AbortSignal;
    readonly operations?: Operations | undefined;
  },
) {
  const { command, reserved, received, signal } = options;
  const { stored, persistedSnapshot, executionGame } = options.execution;
  const { attempt } = received;
  const classified = classifyAiResponse(
    received.response,
    executionGame,
    signal,
    options.operations,
  );
  if (
    !(await tx.finishModelInvocation(
      attempt.id,
      reserved.reservationId,
      invocationResult(classified.response, attempt),
    ))
  ) {
    throw new GameIntegrityError();
  }
  const invalidOutputCount =
    classified.kind === "invalid" ? await tx.incrementAiInvalidCount(attempt.turnId) : 0;
  const decision = decideAiOutcome(classified, invalidOutputCount, signal.aborted);
  if (decision.kind === "retry") return decision;
  if (decision.kind === "technicalLoss") {
    const lost = executionGame.recordTechnicalLoss(reserved.selected.color);
    if (!lost.ok) throw new GameIntegrityError();
    return {
      kind: decision.kind,
      snapshot: await persistCommand(tx, stored, command.commandId, "technical_loss", lost.value),
    };
  }
  let accepted =
    decision.kind === "move" ? executionGame.playMove(decision.move) : executionGame.pause();
  if (!accepted.ok) throw new GameIntegrityError();
  if (command.step && accepted.value.state === "active") accepted = executionGame.pause();
  if (!accepted.ok) throw new GameIntegrityError();
  const snapshot = await persistCommand(
    tx,
    stored,
    command.commandId,
    decision.kind,
    accepted.value,
  );
  if (decision.kind === "move") {
    await tx.linkAiTurnMove(attempt.turnId, persistedSnapshot.moves.length + 1);
  }
  return { kind: decision.kind, snapshot };
}
