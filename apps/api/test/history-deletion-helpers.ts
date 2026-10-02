import { randomUUID } from "node:crypto";

import { type GameSnapshot, gameSnapshotSchema } from "@neurochess/contracts";
import {
  aiControllers,
  aiTurnReservations,
  aiTurns,
  gameCommands,
  gameParticipants,
  games,
  modelInvocations,
  moves,
} from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { expect } from "vitest";

import type { AccountGameHarness } from "./account-game-helpers.js";
import { access, control, humanMatch, output, service, turnCommand } from "./ai-turn-helpers.js";
import type { TestApi } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";

export async function terminalGame(
  harness: AccountGameHarness,
  api: TestApi,
  owner: Awaited<ReturnType<AccountGameHarness["account"]>>,
  completed = false,
) {
  const gameService = service(api, {
    openai: createScriptedAdapter({
      provider: "openai",
      moves: [output("e2e4", "A center move.")],
    }),
  });
  const { snapshot } = await gameService.createAi(owner.principal, humanMatch);
  const moved = await gameService.aiTurn(owner.principal, turnCommand(snapshot), access());
  const response = await harness.post(api, owner.cookie, `/games/${snapshot.gameId}/lifecycle`, {
    ...control(moved, "abort"),
    ...(completed ? { action: "resign", losingColor: "black", controllerId: undefined } : {}),
  });
  expect(response.statusCode, response.body).toBe(200);
  return gameSnapshotSchema.parse(response.json());
}

export async function residualExecution(api: TestApi, snapshot: GameSnapshot) {
  // Terminal transitions normally clear these; deletion must cascade residual records too.
  await api.database.db.insert(aiControllers).values({
    gameId: snapshot.gameId,
    controllerId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await api.database.db.insert(aiTurnReservations).values({
    gameId: snapshot.gameId,
    reservationId: randomUUID(),
    commandId: randomUUID(),
    expectedVersion: snapshot.version,
  });
}

export async function gameRecords(api: TestApi, gameId: string, turnIds?: string[]) {
  const turns = await api.database.db.select().from(aiTurns).where(eq(aiTurns.gameId, gameId));
  const ids = turnIds ?? turns.map((turn) => turn.id);
  return {
    games: await api.database.db.select().from(games).where(eq(games.id, gameId)),
    participants: await api.database.db
      .select()
      .from(gameParticipants)
      .where(eq(gameParticipants.gameId, gameId)),
    moves: await api.database.db.select().from(moves).where(eq(moves.gameId, gameId)),
    commands: await api.database.db
      .select()
      .from(gameCommands)
      .where(eq(gameCommands.gameId, gameId)),
    turns,
    invocations: ids.length
      ? await api.database.db
          .select()
          .from(modelInvocations)
          .where(inArray(modelInvocations.turnId, ids))
      : [],
    reservations: await api.database.db
      .select()
      .from(aiTurnReservations)
      .where(eq(aiTurnReservations.gameId, gameId)),
    controllers: await api.database.db
      .select()
      .from(aiControllers)
      .where(eq(aiControllers.gameId, gameId)),
  };
}

export function deletionPath(gameId?: string) {
  return gameId ? `/games/${gameId}/delete` : "/games/history/clear";
}

export function deletionBody(gameId?: string) {
  return { confirm: true, ...(gameId ? { gameId } : {}) };
}
