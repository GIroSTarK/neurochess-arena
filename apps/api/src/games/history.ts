import {
  gameDeletionRequestSchema,
  type GameHistoryPage,
  gameHistoryPageSchema,
  gameHistoryQuerySchema,
  gameIdSchema,
} from "@neurochess/contracts";
import type { GameRepository } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { lockActivePrincipal, requireActivePrincipal } from "../identity/validity.js";

import { configurationOf } from "./configuration.js";
import { GameIntegrityError, GameRequestError } from "./errors.js";

export async function deleteHistory(
  repository: GameRepository,
  principal: Principal,
  input: unknown,
  scope: { readonly gameId: string } | "all",
): Promise<void> {
  if (principal.kind !== "account") throw new GameRequestError("UNAUTHORIZED");
  if (
    !gameDeletionRequestSchema.safeParse(input).success ||
    (scope !== "all" && !gameIdSchema.safeParse(scope.gameId).success)
  ) {
    throw new GameRequestError("INVALID_REQUEST");
  }
  const gameId = scope === "all" ? undefined : scope.gameId;
  await repository.write(async (tx) => {
    await lockActivePrincipal(tx, principal);
    if (gameId !== undefined) {
      const game = await tx.getGame(gameId);
      if (
        game?.ownerUserId !== principal.userId ||
        game.isSandbox ||
        (game.mode !== "ai_vs_ai" && game.mode !== "ai_vs_human")
      ) {
        throw new GameRequestError("NOT_FOUND");
      }
      if (game.state !== "completed" && game.state !== "aborted") {
        throw new GameRequestError("INVALID_GAME_STATE");
      }
    }
    await tx.deleteAccountHistory(principal.userId, gameId);
    // Cascades may wait for row locks; an expired session rolls back the entire deletion.
    await requireActivePrincipal(tx, principal);
  });
}

export function readHistory(
  repository: GameRepository,
  principal: Principal,
  input: unknown,
): Promise<GameHistoryPage> {
  if (principal.kind !== "account") throw new GameRequestError("UNAUTHORIZED");
  const query = gameHistoryQuerySchema.safeParse(input);
  if (!query.success) throw new GameRequestError("INVALID_REQUEST");
  const { limit, cursor } = query.data;
  const [finishedAt, gameId] = cursor?.split("/") ?? [];
  return repository.read(async (reader) => {
    await requireActivePrincipal(reader, principal);
    const rows = await reader.accountHistory(
      principal.userId,
      limit,
      finishedAt && gameId ? { finishedAt, gameId } : undefined,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const response = gameHistoryPageSchema.safeParse({
      games: page.map((row) => {
        const configuration = configurationOf(row, row.participants);
        if (!configuration) throw new GameIntegrityError();
        const player = (color: "white" | "black") => {
          const seat = configuration.seats[color];
          return seat.type === "human"
            ? { type: "human", username: row.username }
            : { type: "ai", provider: seat.provider, modelId: seat.modelId };
        };
        return {
          gameId: row.id,
          mode: configuration.mode,
          finishedAt: row.finishedAt,
          state: row.state,
          result: row.result,
          terminationReason: row.terminationReason,
          players: { white: player("white"), black: player("black") },
        };
      }),
      nextCursor: rows.length > limit && last ? `${last.finishedAt}/${last.id}` : null,
    });
    if (!response.success) throw new GameIntegrityError();
    return response.data;
  });
}
