import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import type { ChessGame } from "@neurochess/chess";
import {
  aiControlledTurnCommandSchema,
  type AiProvider,
  type GameCommandIdentity,
  type GameSnapshot,
  type NormalizedMoveResponse,
} from "@neurochess/contracts";
import type {
  AiExecutionTransaction,
  GameRepository,
  InvocationResult,
  StoredModelInvocation,
} from "@neurochess/database";

import {
  credentialFailure,
  type ProviderCredentialAccess,
  type ProviderOperationAccess,
} from "../credentials/provider-access.js";
import type { Principal } from "../identity/principal.js";
import { lockIdentity } from "../identity/validity.js";
import { observe, type Operations } from "../monitoring/operations.js";
import { calculateCost, pinPricing } from "../pricing/calculator.js";
import { pricingColumns, readBilling, storedPricing } from "../pricing/persistence.js";
import { AI_MOVE_INSTRUCTIONS, type AiProviderAdapter } from "../providers/adapter.js";
import { discoverModels, effectiveParameters } from "../providers/discovery.js";
import { cancellationFailure, invokeMove } from "../providers/invoke-move.js";

import { decideAiOutcome } from "./ai-outcome-policy.js";
import { authorizeGameControl } from "./authorization.js";
import { persistCommand } from "./command-persistence.js";
import type { CommandPreparationTransaction, PreparedGameCommand } from "./command-preparation.js";
import { requireController } from "./controller-presence.js";
import { AiTurnError, GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";
export { AiTurnError } from "./errors.js";

export type AiAdapters = Readonly<Partial<Record<AiProvider, AiProviderAdapter>>>;

function requireAiSeat(
  principal: Principal,
  restored: Omit<PreparedGameCommand, "game">,
  step = false,
) {
  const { stored, snapshot: persistedSnapshot, configuration, participants } = restored;
  authorizeGameControl(principal, stored);
  if (stored.state !== (step ? "paused" : "active")) {
    throw new GameRequestError("INVALID_GAME_STATE");
  }
  const seat = configuration?.seats[persistedSnapshot.turn];
  const participant = participants.find((entry) => entry.color === persistedSnapshot.turn);
  if (stored.isSandbox || seat?.type !== "ai" || participant?.seatType !== "ai") {
    throw new GameRequestError("FORBIDDEN");
  }
  return { seat, participantId: participant.id, color: persistedSnapshot.turn };
}

function prepareExecutionGame(restoredGame: ChessGame, step = false): ChessGame {
  // A paused step resumes only this in-memory aggregate, never the persisted snapshot.
  if (step && !restoredGame.resume().ok) throw new GameIntegrityError();
  return restoredGame;
}

function invocationResult(
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

export function createAiTurnExecutor(options: {
  readonly operations?: Operations;
  readonly repository: Pick<GameRepository, "write">;
  readonly adapters: AiAdapters;
  readonly useCredential: ProviderCredentialAccess;
  readonly prepareCommand: (
    tx: CommandPreparationTransaction,
    principal: Principal,
    command: GameCommandIdentity,
  ) => Promise<PreparedGameCommand>;
}) {
  const { repository, prepareCommand } = options;
  const adapters = { ...options.adapters };

  return async (
    principal: Principal,
    input: unknown,
    access: ProviderOperationAccess,
  ): Promise<GameSnapshot> => {
    const parsed = aiControlledTurnCommandSchema.safeParse(input);
    if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
    const command = {
      ...parsed.data,
      gameId: parsed.data.gameId.toLowerCase(),
      commandId: parsed.data.commandId.toLowerCase(),
    };
    const reserved = await repository.write(async (tx) => {
      const restored = await prepareCommand(tx, principal, command);
      const { snapshot: persistedSnapshot } = restored;
      const selected = requireAiSeat(principal, restored, command.step);
      const executionGame = prepareExecutionGame(restored.game, command.step);
      await requireController(tx, command.gameId, command.controllerId);
      const pending = await tx.getAiTurnReservation(command.gameId);
      if (pending) {
        throw new AiTurnError(
          pending.state === "in_flight" ? "AI_TURN_IN_PROGRESS" : "AI_TURN_RECOVERY_REQUIRED",
        );
      }
      const adapter = adapters[selected.seat.provider];
      if (adapter?.provider !== selected.seat.provider) {
        throw new AiTurnError("AI_ADAPTER_UNAVAILABLE");
      }
      if (access.signal.aborted) throw new AiTurnError("AI_TURN_CANCELLED");
      const reservationId = randomUUID();
      await tx.reserveAiTurn({
        gameId: command.gameId,
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        reservationId,
      });
      const turn = await tx.getOrCreateAiTurn({
        gameId: command.gameId,
        ply: persistedSnapshot.moves.length + 1,
        color: selected.color,
      });
      if (
        turn.invalidOutputCount >= 3 ||
        turn.acceptedMovePly !== null ||
        turn.color !== selected.color
      ) {
        throw new GameIntegrityError();
      }
      const invocation = {
        turnId: turn.id,
        reservationId,
        commandId: command.commandId,
        expectedVersion: command.expectedVersion,
        provider: selected.seat.provider,
        modelId: selected.seat.modelId,
      };
      const executionSnapshot = executionGame.snapshot();
      return {
        selected,
        adapter,
        reservationId,
        invocation,
        context: {
          fen: executionSnapshot.fen,
          pgn: executionSnapshot.pgn,
          color: executionSnapshot.turn,
          turn: executionSnapshot.turn,
          legalMoves: [...executionSnapshot.legalMoves],
        },
      };
    });

    async function recheck(
      tx: CommandPreparationTransaction &
        Pick<AiExecutionTransaction, "getAiController" | "getAiTurnReservation">,
    ) {
      const restored = await prepareCommand(tx, principal, command);
      const { stored, snapshot: persistedSnapshot } = restored;
      const selected = requireAiSeat(principal, restored, command.step);
      const executionGame = prepareExecutionGame(restored.game, command.step);
      await requireController(tx, command.gameId, command.controllerId);
      const pending = await tx.getAiTurnReservation(command.gameId);
      if (
        pending?.reservationId !== reserved.reservationId ||
        pending.state !== "in_flight" ||
        pending.commandId !== command.commandId ||
        pending.expectedVersion !== command.expectedVersion ||
        !isDeepStrictEqual(selected, reserved.selected)
      ) {
        throw new GameConflictError(persistedSnapshot);
      }
      return { stored, persistedSnapshot, executionGame };
    }

    let attempt: StoredModelInvocation | undefined;
    let response: NormalizedMoveResponse | undefined;
    try {
      // Discovery shares the reservation fence with inference, but never holds database locks.
      const discoveryStarted = performance.now();
      const discovery =
        (await options.useCredential(
          principal,
          reserved.selected.seat.provider,
          access,
          recheck,
          (resolved) => discoverModels(reserved.adapter, resolved, options.operations),
        )) ?? credentialFailure;
      const discoveryDurationMs = Math.max(0, Math.round(performance.now() - discoveryStarted));
      const model = discovery.ok
        ? discovery.models.find((entry) => entry.id === reserved.selected.seat.modelId)
        : undefined;
      const parameters = model
        ? (reserved.adapter.resolveParameters ?? effectiveParameters)(
            reserved.selected.seat.parameters,
            model.capabilities,
          )
        : {};
      if (parameters === null) {
        await repository.write(async (tx) => {
          const { stored, executionGame } = await recheck(tx);
          const paused = executionGame.pause();
          if (!paused.ok) throw new GameIntegrityError();
          await persistCommand(tx, stored, command.commandId, "pause", paused.value);
        });
        throw new AiTurnError("AI_PARAMETERS_INVALID");
      }
      const invocation = {
        ...reserved.invocation,
        effectiveParameters: parameters,
        ...pricingColumns(pinPricing(reserved.invocation.provider, reserved.invocation.modelId)),
      };
      attempt = await repository.write(async (tx) => {
        await recheck(tx);
        return tx.beginModelInvocation(invocation);
      });
      const preparationError = !discovery.ok
        ? discovery.error
        : !model || model.capabilities.moveGeneration === "unsupported"
          ? ({ code: "provider_unavailable", reason: "unsupported_model" } as const)
          : null;
      for (;;) {
        response = preparationError
          ? {
              ok: false,
              error: preparationError,
              durationMs: discoveryDurationMs,
              usage: null,
              providerRequestId: null,
            }
          : ((await options.useCredential(
              principal,
              reserved.selected.seat.provider,
              access,
              recheck,
              (resolved) =>
                invokeMove(
                  reserved.adapter,
                  {
                    ...resolved,
                    instructions: AI_MOVE_INSTRUCTIONS,
                    modelId: reserved.selected.seat.modelId,
                    parameters: { ...invocation.effectiveParameters },
                    ...(model ? { capabilities: structuredClone(model.capabilities) } : {}),
                    context: { ...reserved.context, legalMoves: [...reserved.context.legalMoves] },
                  },
                  options.operations,
                ),
            )) ?? { ...credentialFailure, durationMs: 0, usage: null, providerRequestId: null });
        const currentAttempt = attempt;
        const received = response;
        const outcome = await repository.write(async (tx) => {
          const { stored, persistedSnapshot, executionGame } = await recheck(tx);
          let classified = received;
          if (
            classified.ok &&
            !executionGame.snapshot().legalMoves.includes(classified.output.move)
          ) {
            classified = {
              ...classified,
              ok: false,
              error: { code: "model_invalid", reason: "illegal_move" },
            };
            observe(options.operations, (sink) => sink.increment("modelInvalid"));
          }
          if (classified.ok && access.signal.aborted) {
            classified = { ...classified, ok: false, error: cancellationFailure(access.signal) };
          }
          if (
            !(await tx.finishModelInvocation(
              currentAttempt.id,
              reserved.reservationId,
              invocationResult(classified, currentAttempt),
            ))
          ) {
            throw new GameIntegrityError();
          }
          const invalidOutputCount =
            !classified.ok && classified.error.code === "model_invalid"
              ? await tx.incrementAiInvalidCount(currentAttempt.turnId)
              : 0;
          const decision = decideAiOutcome(classified, invalidOutputCount, access.signal.aborted);
          if (decision.kind === "retry") return decision;
          if (decision.kind === "technicalLoss") {
            const lost = executionGame.recordTechnicalLoss(reserved.selected.color);
            if (!lost.ok) throw new GameIntegrityError();
            return {
              kind: decision.kind,
              snapshot: await persistCommand(
                tx,
                stored,
                command.commandId,
                "technical_loss",
                lost.value,
              ),
            };
          }
          let accepted =
            decision.kind === "move"
              ? executionGame.playMove(decision.move)
              : executionGame.pause();
          if (!accepted.ok) throw new GameIntegrityError();
          if (command.step && accepted.value.state === "active") accepted = executionGame.pause();
          if (!accepted.ok) throw new GameIntegrityError();
          const result = await persistCommand(
            tx,
            stored,
            command.commandId,
            decision.kind,
            accepted.value,
          );
          if (decision.kind === "move") {
            await tx.linkAiTurnMove(currentAttempt.turnId, persistedSnapshot.moves.length + 1);
          }
          return { kind: decision.kind, snapshot: result };
        });
        if (outcome.kind !== "retry") return outcome.snapshot;
        response = undefined;
        const next = await repository.write(async (tx) => {
          const { stored, executionGame } = await recheck(tx);
          if (access.signal.aborted) {
            const paused = executionGame.pause();
            if (!paused.ok) throw new GameIntegrityError();
            return {
              kind: "pause" as const,
              snapshot: await persistCommand(tx, stored, command.commandId, "pause", paused.value),
            };
          }
          return { kind: "retry" as const, attempt: await tx.beginModelInvocation(invocation) };
        });
        if (next.kind === "pause") return next.snapshot;
        attempt = next.attempt;
      }
    } catch (error: unknown) {
      try {
        await repository.write(async (tx) => {
          // Cleanup uses the server's attempt/fence identity, even if the principal has expired.
          await lockIdentity(tx, principal);
          await tx.lockGame(command.gameId);
          if (
            response &&
            attempt &&
            (error instanceof GameConflictError ||
              error instanceof GameRequestError ||
              (error instanceof AiTurnError && error.code === "AI_CONTROLLER_LOST"))
          ) {
            await tx.finishModelInvocation(
              attempt.id,
              reserved.reservationId,
              invocationResult(response, attempt, true),
              true,
            );
          }
          await tx.blockAiTurn(command.gameId, reserved.reservationId);
        });
      } catch {
        // A surviving reservation remains blocked from redispatch until explicit recovery.
      }
      throw error;
    }
  };
}
