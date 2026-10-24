import { randomUUID } from "node:crypto";

import { aiControllerRequestSchema, type GameSnapshot, isAiGameMode } from "@neurochess/contracts";
import type { GameRepository } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { lockIdentity, lockPrincipal, requireActivePrincipal } from "../identity/validity.js";

import { authorizeGameControl, ownerOf } from "./authorization.js";
import { persistCommand } from "./command-persistence.js";
import { CONTROLLER_LEASE_MS } from "./controller-presence.js";
import { AiTurnError, GameConflictError, GameIntegrityError, GameRequestError } from "./errors.js";
import { restoreAuthorizedGame } from "./restoration.js";

export function createControllerService(
  repository: Pick<GameRepository, "write" | "expiredAiControllers">,
  options: { readonly sandboxEnabled: boolean; readonly controllerLeaseMs?: number },
) {
  const leaseMs = options.controllerLeaseMs ?? CONTROLLER_LEASE_MS;
  return {
    async controller(principal: Principal, input: unknown): Promise<GameSnapshot> {
      const parsed = aiControllerRequestSchema.safeParse(input);
      if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
      const command = parsed.data;
      return repository.write(async (tx) => {
        if (!(await lockPrincipal(tx, principal))) {
          throw new GameRequestError("UNAUTHORIZED");
        }
        const stored = await tx.lockGame(command.gameId);
        await requireActivePrincipal(tx, principal);
        if (!stored) throw new GameRequestError("NOT_FOUND");
        const { snapshot } = await restoreAuthorizedGame(
          tx,
          principal,
          stored,
          options.sandboxEnabled,
        );
        authorizeGameControl(principal, stored);
        if (!isAiGameMode(stored.mode)) throw new GameRequestError("FORBIDDEN");
        if (stored.state !== "active" && stored.state !== "paused") {
          throw new GameConflictError(snapshot);
        }
        const controllerId = command.controllerId.toLowerCase();
        if (command.action === "heartbeat") {
          if (!(await tx.renewAiController(stored.id, controllerId, leaseMs))) {
            throw new AiTurnError("AI_CONTROLLER_LOST");
          }
        } else {
          if (command.expectedVersion !== stored.version) throw new GameConflictError(snapshot);
          const lease = await tx.getAiController(stored.id);
          if (
            lease &&
            !lease.expired &&
            lease.controllerId &&
            lease.controllerId !== controllerId
          ) {
            throw new AiTurnError("AI_CONTROLLER_BUSY");
          }
          const initial = stored.version === 0 && lease?.controllerId === null && !lease.expired;
          const current = lease?.controllerId === controllerId && !lease.expired;
          if (stored.state === "active" && !initial && !current) {
            throw new AiTurnError("AI_CONTROLLER_LOST");
          }
          // Reclaiming a paused expired lease must first invalidate any uncertain step.
          if (!current && (await tx.getAiTurnReservation(stored.id))) {
            throw new AiTurnError("AI_TURN_RECOVERY_REQUIRED");
          }
          await tx.setAiController(stored.id, controllerId, leaseMs);
        }
        return snapshot;
      });
    },
    async expireControllers(): Promise<void> {
      for (const candidate of await repository.expiredAiControllers()) {
        await repository.write(async (tx) => {
          const owner = ownerOf(candidate);
          // System cleanup locks the stored owner even after session expiry.
          await lockIdentity(tx, owner);
          const stored = await tx.lockGame(candidate.gameId);
          if (!stored || !isAiGameMode(stored.mode)) return;
          const lease = await tx.getAiController(stored.id);
          if (lease?.expired === false) return;
          if (
            stored.state === "active" ||
            (stored.state === "paused" && (await tx.getAiTurnReservation(stored.id)))
          ) {
            const { game } = await restoreAuthorizedGame(tx, owner, stored, options.sandboxEnabled);
            const paused =
              stored.state === "active"
                ? game.pause()
                : { ok: true as const, value: game.snapshot() };
            if (!paused.ok) throw new GameIntegrityError();
            await persistCommand(tx, stored, randomUUID(), "pause", paused.value);
          }
          await tx.clearAiController(stored.id);
        });
      }
    },
  };
}
