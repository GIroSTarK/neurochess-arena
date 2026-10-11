import { authUsers, gameAnalysisSamples, games, guestSessions } from "@neurochess/database";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";

import { analysisSample } from "./analysis-helpers.js";
import { terminalGame } from "./history-deletion-helpers.js";
import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(() => harness.dispose());

it.each(["single", "clear"])(
  "removes only the requester's room samples atomically on %s history deletion",
  async (action) => {
    const { api, owner, opponent, snapshot } = await harness.room();
    const url = `/games/${snapshot.gameId}/analysis`;
    for (const participant of [owner, opponent]) {
      expect(
        (await harness.post(api, participant.cookie, url, { samples: [analysisSample(snapshot)] }))
          .statusCode,
      ).toBe(200);
    }
    const before = await api.repository.read((reader) => reader.getGame(snapshot.gameId));
    const path = action === "single" ? `/games/${snapshot.gameId}/delete` : "/games/history/clear";
    const payload =
      action === "single" ? { gameId: snapshot.gameId, confirm: true } : { confirm: true };
    expect((await harness.post(api, owner.cookie, path, payload)).statusCode).toBe(200);
    const rows = await api.database.db
      .select()
      .from(gameAnalysisSamples)
      .where(eq(gameAnalysisSamples.gameId, snapshot.gameId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).not.toBe(owner.principal.userId);
    expect((await api.app.inject({ url, headers: { cookie: owner.cookie } })).statusCode).toBe(404);
    expect(
      (await harness.post(api, owner.cookie, url, { samples: [analysisSample(snapshot)] }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.app.inject({ url, headers: { cookie: opponent.cookie } })).json(),
    ).toMatchObject({ samples: [analysisSample(snapshot)] });
    expect(await api.repository.read((reader) => reader.getGame(snapshot.gameId))).toEqual(before);
    expect(
      (
        await harness.post(api, opponent.cookie, `/games/${snapshot.gameId}/delete`, {
          gameId: snapshot.gameId,
          confirm: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await api.database.db.$count(
        gameAnalysisSamples,
        eq(gameAnalysisSamples.gameId, snapshot.gameId),
      ),
    ).toBe(0);
    expect(await api.repository.read((reader) => reader.getGame(snapshot.gameId))).toBeUndefined();
  },
);

it("rolls back analysis removal with retained access if history deletion fails", async () => {
  const { api, owner, snapshot } = await harness.room();
  const url = `/games/${snapshot.gameId}/analysis`;
  expect(
    (await harness.post(api, owner.cookie, url, { samples: [analysisSample(snapshot)] }))
      .statusCode,
  ).toBe(200);
  const failing = createGameService(
    {
      ...api.repository,
      write: (action) =>
        api.repository.write((tx) =>
          action({
            ...tx,
            deleteAccountHistory: async (...args) => {
              await tx.deleteAccountHistory(...args);
              expect(
                await tx.getAnalysisSamples(owner.principal.userId, snapshot.gameId, 128),
              ).toEqual([]);
              throw new Error("Injected deletion failure");
            },
          }),
        ),
    },
    { nodeEnv: "test", sandboxEnabled: false },
  );
  await expect(
    failing.deleteGame(owner.principal, { gameId: snapshot.gameId, confirm: true }),
  ).rejects.toThrow("Injected deletion failure");
  const read = await api.app.inject({ url, headers: { cookie: owner.cookie } });
  expect(read.statusCode).toBe(200);
  expect(analysisReadResponseSchema.parse(read.json()).samples).toHaveLength(1);
});

it("cascades solo game and account deletion without retaining analysis identities", async () => {
  const api = await harness.createAuthenticatedApi();
  const owner = await harness.account(api);
  const snapshot = await terminalGame(harness, api, owner);
  const url = `/games/${snapshot.gameId}/analysis`;
  expect(
    (await harness.post(api, owner.cookie, url, { samples: [analysisSample(snapshot)] }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await harness.post(api, owner.cookie, `/games/${snapshot.gameId}/delete`, {
        gameId: snapshot.gameId,
        confirm: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    await api.database.db.$count(
      gameAnalysisSamples,
      eq(gameAnalysisSamples.gameId, snapshot.gameId),
    ),
  ).toBe(0);
  const next = await harness.createGame(api, owner.cookie);
  expect(
    (
      await harness.post(api, owner.cookie, `/games/${next.snapshot.gameId}/analysis`, {
        samples: [analysisSample(next.snapshot)],
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true }))
      .statusCode,
  ).toBe(200);
  expect(await api.database.db.$count(authUsers, eq(authUsers.id, owner.principal.userId))).toBe(0);
  expect(
    await api.database.db.$count(
      gameAnalysisSamples,
      eq(gameAnalysisSamples.userId, owner.principal.userId),
    ),
  ).toBe(0);
});

it("removes live-room account samples while preserving the opponent's analysis through abortion", async () => {
  const { api, owner, opponent, snapshot } = await harness.room({ state: "active" });
  const url = `/games/${snapshot.gameId}/analysis`;
  for (const participant of [owner, opponent]) {
    expect(
      (await harness.post(api, participant.cookie, url, { samples: [analysisSample(snapshot)] }))
        .statusCode,
    ).toBe(200);
  }
  expect(
    (await harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true }))
      .statusCode,
  ).toBe(200);
  expect(
    await api.database.db.$count(
      gameAnalysisSamples,
      and(
        eq(gameAnalysisSamples.userId, owner.principal.userId),
        eq(gameAnalysisSamples.gameId, snapshot.gameId),
      ),
    ),
  ).toBe(0);
  expect(
    (await api.app.inject({ url, headers: { cookie: opponent.cookie } })).json(),
  ).toMatchObject({ samples: [analysisSample(snapshot)] });
  expect(await api.repository.read((reader) => reader.getGame(snapshot.gameId))).toMatchObject({
    state: "aborted",
  });
});

it("removes account samples at last account access while a valid guest delays physical room cleanup", async () => {
  const { api, owner, opponent, snapshot } = await harness.room({ guest: true });
  const url = `/games/${snapshot.gameId}/analysis`;
  expect(
    (await harness.post(api, owner.cookie, url, { samples: [analysisSample(snapshot)] }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await harness.post(api, owner.cookie, `/games/${snapshot.gameId}/delete`, {
        gameId: snapshot.gameId,
        confirm: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    await api.database.db.$count(
      gameAnalysisSamples,
      eq(gameAnalysisSamples.gameId, snapshot.gameId),
    ),
  ).toBe(0);
  expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(1);
  expect(
    (await harness.post(api, owner.cookie, url, { samples: [analysisSample(snapshot)] }))
      .statusCode,
  ).toBe(404);
  if (opponent.principal.kind !== "guest") throw new Error("Expected guest fixture");
  await api.database.db
    .update(guestSessions)
    .set({ lastSeenAt: new Date(1), expiresAt: new Date(2) })
    .where(eq(guestSessions.id, opponent.principal.guestSessionId));
  await api.repository.cleanupSharedRooms();
  expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(0);
});
import { analysisReadResponseSchema } from "@neurochess/contracts";
