import { performance } from "node:perf_hooks";

import {
  aiControlledTurnCommandSchema,
  type GameSnapshot,
  type NormalizedMoveResponse,
} from "@neurochess/contracts";
import type { AiExecutionTransaction, GameRepository } from "@neurochess/database";

import {
  credentialFailure,
  type ProviderCredentialAccess,
  type ProviderOperationAccess,
} from "../credentials/provider-access.js";
import type { Principal } from "../identity/principal.js";
import type { Operations } from "../monitoring/operations.js";
import { pinPricing } from "../pricing/calculator.js";
import { pricingColumns } from "../pricing/persistence.js";
import { AI_MOVE_INSTRUCTIONS } from "../providers/adapter.js";
import { discoverModels, effectiveParameters } from "../providers/discovery.js";
import { invokeMove } from "../providers/invoke-move.js";

import { type AiAttemptState, commitAiAttempt } from "./ai-turn-outcome.js";
import { recoverAiExecution } from "./ai-turn-recovery.js";
import {
  type AiAdapters,
  type PrepareAiCommand,
  recheckAiExecution,
  reserveAiExecution,
} from "./ai-turn-reservation.js";
import { persistCommand } from "./command-persistence.js";
import type { CommandPreparationTransaction } from "./command-preparation.js";
import { AiTurnError, GameIntegrityError, GameRequestError } from "./errors.js";
export { AiTurnError } from "./errors.js";

export type { AiAdapters } from "./ai-turn-reservation.js";

export function createAiTurnExecutor(options: {
  readonly operations?: Operations;
  readonly repository: Pick<GameRepository, "write">;
  readonly adapters: AiAdapters;
  readonly useCredential: ProviderCredentialAccess;
  readonly prepareCommand: PrepareAiCommand;
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
    const reserved = await repository.write((tx) =>
      reserveAiExecution(tx, principal, command, {
        prepareCommand,
        adapters,
        signal: access.signal,
      }),
    );
    const recheck = (
      tx: CommandPreparationTransaction &
        Pick<AiExecutionTransaction, "getAiController" | "getAiTurnReservation">,
    ) => recheckAiExecution(tx, principal, command, reserved, prepareCommand);

    let attemptState: AiAttemptState = { kind: "none" };
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
      attemptState = {
        kind: "inFlight",
        attempt: await repository.write(async (tx) => {
          await recheck(tx);
          return tx.beginModelInvocation(invocation);
        }),
      };
      const preparationError = !discovery.ok
        ? discovery.error
        : !model || model.capabilities.moveGeneration === "unsupported"
          ? ({ code: "provider_unavailable", reason: "unsupported_model" } as const)
          : null;
      for (;;) {
        const response: NormalizedMoveResponse = preparationError
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
        attemptState = { kind: "received", attempt: attemptState.attempt, response };
        const received = attemptState;
        const outcome = await repository.write(async (tx) =>
          commitAiAttempt(tx, {
            execution: await recheck(tx),
            command,
            reserved,
            received,
            signal: access.signal,
            operations: options.operations,
          }),
        );
        if (outcome.kind !== "retry") return outcome.snapshot;
        // The committed response cannot finalize an attempt prepared for the next dispatch.
        attemptState = { kind: "none" };
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
        attemptState = { kind: "inFlight", attempt: next.attempt };
      }
    } catch (error: unknown) {
      try {
        await repository.write((tx) =>
          recoverAiExecution(
            tx,
            principal,
            command.gameId,
            reserved.reservationId,
            attemptState,
            error,
          ),
        );
      } catch {
        // A surviving reservation remains blocked from redispatch until explicit recovery.
      }
      throw error;
    }
  };
}
