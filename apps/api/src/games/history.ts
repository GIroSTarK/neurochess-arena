import {
  type GameHistoryPage,
  gameHistoryPageSchema,
  gameHistoryQuerySchema,
} from "@neurochess/contracts";
import type { GameRepository } from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { requireActivePrincipal } from "../identity/validity.js";

import { configurationOf } from "./configuration.js";
import { GameIntegrityError, GameRequestError } from "./errors.js";

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
