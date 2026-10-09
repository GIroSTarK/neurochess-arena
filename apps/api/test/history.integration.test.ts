import { randomUUID } from "node:crypto";

import {
  gameDetailsSchema,
  gameHistoryResponseSchema,
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { aiControllers, authSessions, gameCommands, games } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { AccountGameHarness } from "./account-game-helpers.js";
import { control, humanMatch } from "./ai-turn-helpers.js";
import { createSandbox, type TestApi } from "./helpers.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

async function terminal(api: TestApi, cookie: string, completed = false) {
  const { snapshot } = await harness.createGame(api, cookie, humanMatch);
  const response = await harness.post(api, cookie, `/games/${snapshot.gameId}/lifecycle`, {
    ...control(snapshot, "abort"),
    ...(completed ? { action: "resign", losingColor: "black", controllerId: undefined } : {}),
  });
  expect(response.statusCode, response.body).toBe(200);
  return gameSnapshotSchema.parse(response.json());
}

function history(api: TestApi, cookie: string, query = "") {
  return api.app.inject({ url: "/games/history" + query, headers: { cookie } });
}

describe("private account history", () => {
  it("lists only terminal public account games across sessions and reuses private result paths", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    const stopped = await terminal(api, owner.cookie);
    const completed = await terminal(api, owner.cookie, true);
    const current = await harness.createGame(api, owner.cookie);
    await terminal(api, guest.cookie);
    const sandbox = await createSandbox(api, guest);
    await harness.post(
      api,
      guest.cookie,
      `/games/${sandbox.gameId}/lifecycle`,
      control(sandbox, "abort"),
    );
    await terminal(api, other.cookie);
    const second = await owner.anotherSession();
    const before = await api.database.db
      .select()
      .from(gameCommands)
      .where(eq(gameCommands.gameId, current.snapshot.gameId));
    const controllerBefore = await api.database.db
      .select()
      .from(aiControllers)
      .where(eq(aiControllers.gameId, current.snapshot.gameId));
    const response = await history(api, `${second.cookie}; ${guest.cookie}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
    const result = gameHistoryResponseSchema.parse(response.json());
    const username = await api.repository.read((reader) =>
      reader.getAccountUsername(owner.principal.userId),
    );
    expect(result).toEqual({
      games: [completed, stopped].map((snapshot) => ({
        gameId: snapshot.gameId,
        finishedAt: result.games.find((game) => game.gameId === snapshot.gameId)?.finishedAt,
        configuration: humanMatch,
        players: { white: null, black: { kind: "account", username } },
        state: snapshot.state,
        result: snapshot.result,
        terminationReason: snapshot.terminationReason,
      })),
      nextCursor: null,
    });
    for (const snapshot of [completed, stopped]) {
      for (const suffix of ["/details", "/replay", "/pgn", "/invocations"]) {
        const read = await api.app.inject({
          url: `/games/${snapshot.gameId}${suffix}`,
          headers: { cookie: second.cookie },
        });
        expect(read.statusCode, read.body).toBe(200);
        if (suffix === "/pgn") {
          expect(gamePgnResponseSchema.parse(read.json()).pgn).toBe(snapshot.pgn);
        }
        if (suffix === "/replay") {
          expect(gameReplayResponseSchema.parse(read.json()).snapshot).toEqual(snapshot);
        }
        if (suffix === "/details") {
          expect(gameDetailsSchema.parse(read.json()).snapshot).toEqual(snapshot);
        }
        for (const cookie of [other.cookie, guest.cookie]) {
          const denied = await api.app.inject({
            url: `/games/${snapshot.gameId}${suffix}`,
            headers: { cookie },
          });
          expect(denied.statusCode).toBe(404);
          expect(denied.body).not.toContain(snapshot.gameId);
        }
      }
    }
    expect(
      await api.database.db
        .select()
        .from(gameCommands)
        .where(eq(gameCommands.gameId, current.snapshot.gameId)),
    ).toEqual(before);
    expect(
      await api.database.db
        .select()
        .from(aiControllers)
        .where(eq(aiControllers.gameId, current.snapshot.gameId)),
    ).toEqual(controllerBefore);
    expect(
      gameSnapshotSchema.parse(
        (
          await api.app.inject({
            url: `/games/${current.snapshot.gameId}`,
            headers: { cookie: owner.cookie },
          })
        ).json(),
      ).state,
    ).toBe("active");
  });

  it("paginates ties and sub-millisecond timestamps without gaps or repeats when newer games arrive", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const entries = [];
    for (const timestamp of ["000001", "000002", "000002", "000003", "000004"]) {
      const snapshot = await terminal(api, owner.cookie);
      const finishedAt = `2026-10-01T12:00:00.${timestamp}Z`;
      await api.database.db
        .update(games)
        .set({ updatedAt: sql`${finishedAt}::timestamptz` })
        .where(eq(games.id, snapshot.gameId));
      entries.push({ gameId: snapshot.gameId, finishedAt });
    }
    entries.sort(
      (a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.gameId.localeCompare(a.gameId),
    );
    const first = await history(api, owner.cookie, "?limit=2");
    expect(first.statusCode, first.body).toBe(200);
    const firstPage = gameHistoryResponseSchema.parse(first.json());
    const seen = firstPage.games.map((game) => game.gameId);
    await terminal(api, owner.cookie);
    let cursor = firstPage.nextCursor;
    while (cursor) {
      const response = await history(
        api,
        owner.cookie,
        "?limit=2&cursor=" + encodeURIComponent(cursor),
      );
      expect(response.statusCode, response.body).toBe(200);
      const page = gameHistoryResponseSchema.parse(response.json());
      seen.push(...page.games.map((game) => game.gameId));
      cursor = page.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(5);
    }
    expect(seen).toEqual(entries.map((entry) => entry.gameId));
    const other = await harness.account(api);
    expect(
      (
        await history(
          api,
          other.cookie,
          "?cursor=" + encodeURIComponent(firstPage.nextCursor ?? ""),
        )
      ).json(),
    ).toEqual({ games: [], nextCursor: null });
  });

  it("rejects guests, expired sessions, uncompleted profiles, malformed bounds and client-selected owners", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const guest = await harness.guest(api);
    for (const cookie of ["", guest.cookie]) {
      expect((await history(api, cookie)).statusCode).toBe(401);
    }
    expect((await history(api, owner.cookie)).json()).toEqual({ games: [], nextCursor: null });
    for (const query of [
      "?limit=0",
      "?limit=51",
      "?limit=1.5",
      "?limit=foo",
      "?limit=",
      "?cursor=",
      "?cursor=bad",
      "?ownerUserId=" + owner.principal.userId,
    ]) {
      expect((await history(api, owner.cookie, query)).statusCode, query).toBe(400);
    }
    const stalePage = await api.app.inject({
      url: "/games/history",
      headers: { cookie: owner.cookie, "x-neurochess-expected-account": randomUUID() },
    });
    expect(stalePage.statusCode).toBe(401);
    const incomplete = await harness.account(api, false);
    expect((await history(api, incomplete.cookie)).statusCode).toBe(403);
    await api.database.db
      .update(authSessions)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSessions.id, owner.principal.sessionId));
    expect((await history(api, `${owner.cookie}; ${guest.cookie}`)).statusCode).toBe(401);
  });
});
