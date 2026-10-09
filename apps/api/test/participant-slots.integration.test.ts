import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import { authSessions, games, gameSlots } from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { positionOf, transportSnapshot } from "../src/games/command-persistence.js";
import { createGameService } from "../src/games/service.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { aiMatch, humanMatch } from "./ai-turn-helpers.js";
import { createSandbox } from "./helpers.js";

const harness = new AccountGameHarness();
const gameIds: string[] = [];
afterEach(async () => {
  const database = integrationDatabase();
  try {
    if (gameIds.length) await database.db.delete(games).where(inArray(games.id, gameIds.splice(0)));
  } finally {
    await database.close();
    await harness.dispose();
  }
});

describe("participant-wide public game recovery and creation", () => {
  it("rolls back game, seats and reservation when the account session expires during creation", async () => {
    const api = await harness.createAuthenticatedApi();
    const player = await harness.account(api);
    const service = createGameService(
      {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              async insertGame(game, seats) {
                await tx.insertGame(game, seats);
                await api.database.db
                  .update(authSessions)
                  .set({ expiresAt: new Date(0) })
                  .where(eq(authSessions.id, player.principal.sessionId));
              },
            }),
          ),
      },
      { nodeEnv: "test", sandboxEnabled: true },
    );
    await expect(service.createAi(player.principal, aiMatch)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(
      await api.database.db.$count(games, eq(games.ownerUserId, player.principal.userId)),
    ).toBe(0);
    expect(
      await api.database.db.$count(gameSlots, eq(gameSlots.userId, player.principal.userId)),
    ).toBe(0);
  });

  it.each(["account", "guest"] as const)(
    "recovers a non-owner %s room after restart and blocks both AI modes without affecting Sandbox",
    async (kind) => {
      const api = await harness.createAuthenticatedApi();
      const owner = await harness.account(api);
      const player = kind === "account" ? await harness.account(api) : await harness.guest(api);
      const outsider = await harness.guest(api);
      const gameId = randomUUID();
      gameIds.push(gameId);
      const chess = createGame();
      chess.start();
      chess.playMove("e2e4");
      const snapshot = transportSnapshot(gameId, 1, chess.snapshot());
      await api.repository.write(async (tx) => {
        await tx.insertGame(
          {
            id: gameId,
            ownerUserId: owner.principal.userId,
            mode: "human_vs_human",
            ...positionOf(snapshot),
          },
          [
            { gameId, color: "black", seatType: "human", userId: owner.principal.userId },
            {
              gameId,
              color: "white",
              seatType: "human",
              ...(player.principal.kind === "account"
                ? { userId: player.principal.userId }
                : { guestSessionId: player.principal.guestSessionId }),
            },
          ],
        );
        await tx.insertRoom({ gameId, ownerColor: "black", state: "joined", joinedAt: new Date() });
        const commandId = randomUUID();
        await tx.appendCommand({ gameId, commandId, kind: "move", version: 1 });
        await tx.appendMove({ ...snapshot.moves[0]!, gameId, commandId, version: 1 });
      });
      const restarted = await harness.createAuthenticatedApi();
      for (const participant of [owner, player]) {
        const recovered = await restarted.app.inject({
          url: "/games/unfinished",
          headers: { cookie: participant.cookie },
        });
        expect(recovered.statusCode, recovered.body).toBe(200);
        expect(recovered.json()).toMatchObject({
          game: { snapshot, configuration: { mode: "human_vs_human" } },
        });
        for (const configuration of [aiMatch, humanMatch]) {
          const conflict = await harness.post(
            restarted,
            participant.cookie,
            "/games",
            configuration,
          );
          expect(conflict.statusCode, conflict.body).toBe(409);
          expect(conflict.json()).toMatchObject({
            code: "GAME_CONFLICT",
            currentSnapshot: snapshot,
          });
        }
      }
      const empty = await restarted.app.inject({
        url: "/games/unfinished",
        headers: { cookie: outsider.cookie },
      });
      expect(empty.json()).toEqual({ game: null });
      if (player.principal.kind === "guest") {
        const sandbox = await createSandbox(
          restarted,
          player as Awaited<ReturnType<typeof harness.guest>>,
        );
        expect(sandbox.gameId).not.toBe(gameId);
        const duplicate = await harness.post(restarted, player.cookie, "/sandbox/games", {});
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json()).toMatchObject({ currentSnapshot: sandbox });
      }
    },
  );
});
