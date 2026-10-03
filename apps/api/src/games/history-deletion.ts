import {
  gameDeleteRequestSchema,
  gameHistoryClearRequestSchema,
  type GameHistoryDeletedResponse,
} from "@neurochess/contracts";
import type { GameRepository } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { lockPrincipal, requireActivePrincipal } from "../identity/validity.js";

import { GameRequestError } from "./errors.js";

export function createHistoryDeletion(repository: GameRepository) {
  async function remove(
    principal: Principal,
    gameId?: string,
  ): Promise<GameHistoryDeletedResponse> {
    if (principal.kind !== "account") throw new GameRequestError("UNAUTHORIZED");
    return repository.write(async (tx) => {
      if (!(await lockPrincipal(tx, principal))) throw new GameRequestError("UNAUTHORIZED");
      if (gameId !== undefined) {
        const candidate = await tx.getGame(gameId);
        // Missing and out-of-scope IDs share the same retry-safe response; never lock a foreign game.
        if (
          candidate?.ownerUserId !== principal.userId ||
          candidate.isSandbox ||
          candidate.mode === null
        ) {
          await requireActivePrincipal(tx, principal);
          return { status: "deleted" };
        }
        const game = await tx.lockGame(gameId);
        await requireActivePrincipal(tx, principal);
        if (game && game.state !== "completed" && game.state !== "aborted") {
          throw new GameRequestError("INVALID_GAME_STATE");
        }
      }
      // The account lock orders this boundary with completion/creation on every API instance.
      await tx.deleteAccountHistory(principal.userId, gameId);
      // Expiry during a DELETE/cascade lock wait must roll back the entire operation.
      await requireActivePrincipal(tx, principal);
      return { status: "deleted" };
    });
  }
  return {
    async deleteGame(principal: Principal, input: unknown) {
      const parsed = gameDeleteRequestSchema.safeParse(input);
      if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
      return remove(principal, parsed.data.gameId.toLowerCase());
    },
    async clearHistory(principal: Principal, input: unknown) {
      if (!gameHistoryClearRequestSchema.safeParse(input).success) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      return remove(principal);
    },
  };
}
