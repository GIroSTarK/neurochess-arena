import { gameSnapshotSchema } from "@neurochess/contracts";
import {
  aiControllers,
  aiTurnReservations,
  aiTurns,
  gameCommands,
  gameParticipants,
  games,
  guestSessions,
  modelInvocations,
  moves,
} from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { expect, it } from "vitest";

import { snapshot, type TestApi } from "./helpers.js";
import { createProviderGame, turn, withProviderApi } from "./providers/integration-helpers.js";
import { openAiFixture } from "./providers/openai-fixtures.js";

it("cleans a failed provider case, including pending HTTP work, without deleting another case's fixtures", async () => {
  await withProviderApi(openAiFixture, [], async (survivor) => {
    const survivingGame = await createProviderGame(survivor.api, survivor.guest, openAiFixture);
    let failed: { api: TestApi; guestId: string; gameId: string; turnIds: string[] } | undefined;
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    await expect(
      withProviderApi(
        openAiFixture,
        [
          ...openAiFixture.catalog([openAiFixture.modelId]),
          openAiFixture.completion('{"move":"e2e4"}'),
          ...openAiFixture.catalog([openAiFixture.modelId]),
          () => {
            entered.resolve();
            return response.promise;
          },
        ],
        async ({ api, guest, http }) => {
          const initial = await createProviderGame(api, guest, openAiFixture);
          const first = await turn(api, guest, initial);
          expect(first.statusCode, first.body).toBe(200);
          const pending = turn(api, guest, gameSnapshotSchema.parse(first.json()));
          try {
            await entered.promise;
            const turns = await api.database.db
              .select()
              .from(aiTurns)
              .where(eq(aiTurns.gameId, initial.gameId));
            expect(turns).toHaveLength(2);
            expect(
              await api.database.db
                .select()
                .from(aiTurnReservations)
                .where(eq(aiTurnReservations.gameId, initial.gameId)),
            ).toHaveLength(1);
            failed = {
              api,
              guestId: guest.id,
              gameId: initial.gameId,
              turnIds: turns.map(({ id }) => id),
            };
            expect.fail("Injected assertion failure with inference still pending");
          } finally {
            response.resolve(openAiFixture.completion('{"move":"g8f6"}'));
            await pending;
            expect(http.transport).toHaveBeenCalledTimes(4);
          }
        },
      ),
    ).rejects.toThrow("Injected assertion failure with inference still pending");
    expect(failed).toBeDefined();
    const { api, guestId, gameId, turnIds } = failed!;
    await expect(api.app.inject({ method: "GET", url: "/games/unfinished" })).rejects.toMatchObject(
      { code: "FST_ERR_REOPENED_CLOSE_SERVER" },
    );
    await expect(api.database.check()).rejects.toThrow(
      "Cannot use a pool after calling end on the pool",
    );
    const db = survivor.api.database.db;
    const deleted = await Promise.all([
      db.select().from(guestSessions).where(eq(guestSessions.id, guestId)),
      db.select().from(games).where(eq(games.id, gameId)),
      db.select().from(gameParticipants).where(eq(gameParticipants.gameId, gameId)),
      db.select().from(moves).where(eq(moves.gameId, gameId)),
      db.select().from(gameCommands).where(eq(gameCommands.gameId, gameId)),
      db.select().from(aiControllers).where(eq(aiControllers.gameId, gameId)),
      db.select().from(aiTurnReservations).where(eq(aiTurnReservations.gameId, gameId)),
      db.select().from(aiTurns).where(eq(aiTurns.gameId, gameId)),
      db.select().from(modelInvocations).where(inArray(modelInvocations.turnId, turnIds)),
    ]);
    expect(deleted).toEqual(Array.from({ length: 9 }, () => []));
    expect(await snapshot(survivor.api, survivor.guest, survivingGame.gameId)).toEqual(
      survivingGame,
    );
    expect(
      await db
        .select({ id: guestSessions.id })
        .from(guestSessions)
        .where(eq(guestSessions.id, survivor.guest.id)),
    ).toEqual([{ id: survivor.guest.id }]);
  });
});
