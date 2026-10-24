import {
  type GameHistoryQuery,
  gameHistoryQuerySchema,
  type GameHistoryResponse,
  gameHistoryResponseSchema,
} from "@neurochess/contracts";
import type { GameRepository } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { requireActivePrincipal } from "../identity/validity.js";

import { configurationOf } from "./configuration.js";
import { GameIntegrityError, GameRequestError } from "./errors.js";

export function createHistoryReader(repository: Pick<GameRepository, "read">) {
  return async function history(
    principal: Principal,
    input: GameHistoryQuery,
  ): Promise<GameHistoryResponse> {
    if (principal.kind !== "account") throw new GameRequestError("UNAUTHORIZED");
    const parsed = gameHistoryQuerySchema.safeParse(input);
    if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
    const { limit, cursor } = parsed.data;
    const [finishedAt, gameId] = cursor?.split("_") ?? [];
    return repository.read(async (reader) => {
      await requireActivePrincipal(reader, principal);
      const records = await reader.findAccountHistory(
        principal.userId,
        limit + 1,
        finishedAt && gameId ? { finishedAt, gameId } : undefined,
      );
      const page = records.slice(0, limit);
      const last = page.at(-1);
      const result = gameHistoryResponseSchema.safeParse({
        games: page.map((game) => ({
          gameId: game.id,
          finishedAt: game.finishedAt,
          configuration: configurationOf(game, game.participants, game.room),
          players: Object.fromEntries(
            game.participants.map((seat) => [
              seat.color,
              seat.seatType === "ai"
                ? null
                : seat.userId
                  ? { kind: "account", username: seat.username }
                  : seat.guestSessionId
                    ? { kind: "guest" }
                    : game.room?.state === "waiting" && seat.color !== game.room.ownerColor
                      ? { kind: "unassigned" }
                      : { kind: "deleted" },
            ]),
          ),
          state: game.state,
          result: game.result,
          terminationReason: game.terminationReason,
        })),
        nextCursor: records.length > limit && last ? `${last.finishedAt}_${last.id}` : null,
      });
      if (!result.success) throw new GameIntegrityError();
      return result.data;
    });
  };
}
