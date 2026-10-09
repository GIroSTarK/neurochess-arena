import {
  gameDeleteRequestSchema,
  gameHistoryClearRequestSchema,
  type GameHistoryDeletedResponse,
  isAiGameMode,
} from "@neurochess/contracts";
import type { GameRepository } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { lockPrincipal, requireActivePrincipal } from "../identity/validity.js";

import { GameRequestError } from "./errors.js";
import { cleanupAfterCommit } from "./shared-room-cleanup.js";

export function createHistoryDeletion(repository: GameRepository) {
  async function remove(
    principal: Principal,
    gameId?: string,
    onCleanupFailure?: () => void,
  ): Promise<GameHistoryDeletedResponse> {
    if (principal.kind !== "account") throw new GameRequestError("UNAUTHORIZED");
    const result = await repository.write(async (tx) => {
      await tx.lockSharedRooms();
      if (!(await lockPrincipal(tx, principal))) throw new GameRequestError("UNAUTHORIZED");
      if (gameId !== undefined) {
        const candidate = await tx.getGame(gameId);
        // Missing and out-of-scope IDs share the same retry-safe response; never lock a foreign game.
        if (
          !candidate ||
          candidate.isSandbox ||
          !(candidate.mode === "human_vs_human"
            ? await tx.hasRetainedRoomAccess(candidate.id, principal.userId)
            : isAiGameMode(candidate.mode) && candidate.ownerUserId === principal.userId)
        ) {
          await requireActivePrincipal(tx, principal);
          return { status: "deleted" as const };
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
      return { status: "deleted" as const };
    });
    await cleanupAfterCommit(() => repository.cleanupSharedRooms(), onCleanupFailure);
    return result;
  }
  return {
    async deleteGame(principal: Principal, input: unknown, onCleanupFailure?: () => void) {
      const parsed = gameDeleteRequestSchema.safeParse(input);
      if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
      return remove(principal, parsed.data.gameId.toLowerCase(), onCleanupFailure);
    },
    async clearHistory(principal: Principal, input: unknown, onCleanupFailure?: () => void) {
      if (!gameHistoryClearRequestSchema.safeParse(input).success) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      return remove(principal, undefined, onCleanupFailure);
    },
  };
}
