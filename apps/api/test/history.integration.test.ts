import { randomUUID } from "node:crypto";

import {
  type AiGameConfiguration,
  gameDetailsSchema,
  gameHistoryPageSchema,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { authSchema, games, profiles } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { AUTH_COOKIE_NAME } from "../src/auth/service.js";

import { AccountGameHarness, get, post } from "./account-game-helpers.js";
import { aiMatch, humanMatch, service } from "./ai-turn-helpers.js";
import type { TestApi } from "./helpers.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

async function terminal(
  api: TestApi,
  cookie: string,
  configuration: AiGameConfiguration = aiMatch,
) {
  const created = await post(api, cookie, "/games", configuration);
  expect(created.statusCode).toBe(201);
  const { snapshot } = gameDetailsSchema.parse(created.json());
  const ended = await post(api, cookie, `/games/${snapshot.gameId}/lifecycle`, {
    gameId: snapshot.gameId,
    expectedVersion: snapshot.version,
    commandId: randomUUID(),
    ...(configuration.mode === "ai_vs_human"
      ? { action: "resign", losingColor: "black" }
      : { action: "abort" }),
  });
  expect(ended.statusCode).toBe(200);
  return gameSnapshotSchema.parse(ended.json());
}

describe("durable private account history", () => {
  it("keeps pre-onboarding human games readable and uses the current chosen username once available", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const completed = await terminal(api, owner.cookie, humanMatch);
    // Accounts could play before P3-06 introduced profiles; its migration leaves names unchosen.
    await api.database.db.delete(profiles).where(eq(profiles.userId, owner.userId));
    const before = await get(api, owner.cookie, "/games/history");
    expect(before.statusCode).toBe(200);
    expect(gameHistoryPageSchema.parse(before.json()).games[0]).toMatchObject({
      gameId: completed.gameId,
      players: { black: { type: "human", username: null } },
    });
    const username = "History_" + randomUUID().replaceAll("-", "").slice(0, 16);
    expect(
      (await post(api, owner.cookie, "/api/profile/onboarding", { username })).statusCode,
    ).toBe(200);
    expect(
      gameHistoryPageSchema.parse((await get(api, owner.cookie, "/games/history")).json()).games[0]
        ?.players.black,
    ).toEqual({ type: "human", username });
  });

  it("lists only owned terminal public games across sessions and keeps all archive reads private and read-only", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    const completed = await terminal(api, owner.cookie, humanMatch);
    const aborted = await terminal(api, owner.cookie);
    await terminal(api, other.cookie);
    await terminal(api, guest.cookie);
    const sandbox = await service(api).createSandbox(guest.principal);
    await service(api).lifecycle(guest.principal, {
      gameId: sandbox.gameId,
      expectedVersion: sandbox.version,
      commandId: randomUUID(),
      action: "abort",
    });
    const active = gameDetailsSchema.parse(
      (await post(api, owner.cookie, "/games", aiMatch)).json(),
    );
    const secondApi = await harness.createApi();
    const secondSession = await harness.anotherSession(secondApi, owner);
    const before = await api.repository.read((reader) => reader.getGame(active.snapshot.gameId));
    const response = await get(
      secondApi,
      `${secondSession.cookie}; ${guest.cookie}`,
      "/games/history",
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const page = gameHistoryPageSchema.parse(response.json());
    expect(page.games.map((game) => game.gameId)).toEqual([aborted.gameId, completed.gameId]);
    expect(page.nextCursor).toBeNull();
    expect(page.games[1]).toMatchObject({
      mode: "ai_vs_human",
      state: "completed",
      result: "1-0",
      terminationReason: "human_resignation",
      players: {
        white: { type: "ai", provider: "openai", modelId: "fixture-white" },
        black: { type: "human" },
      },
    });
    expect(JSON.stringify(page)).not.toContain(owner.email);
    for (const snapshot of [completed, aborted]) {
      for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
        const url = `/games/${snapshot.gameId}${suffix}`;
        expect((await get(secondApi, secondSession.cookie, url)).statusCode).toBe(200);
        for (const cookie of [other.cookie, guest.cookie, ""]) {
          expect((await get(api, cookie, url)).statusCode).toBe(cookie ? 404 : 401);
        }
      }
      expect((await get(api, owner.cookie, `/games/${snapshot.gameId}/pgn`)).json()).toMatchObject({
        pgn: snapshot.pgn,
      });
      expect(
        (await get(api, owner.cookie, `/games/${snapshot.gameId}/replay`)).json(),
      ).toMatchObject({ snapshot });
    }
    expect(await api.repository.read((reader) => reader.getGame(active.snapshot.gameId))).toEqual(
      before,
    );
    expect((await get(api, guest.cookie, "/games/history")).statusCode).toBe(401);
    expect((await get(api, "", "/games/history")).statusCode).toBe(401);
    const invalidCookie = `${AUTH_COOKIE_NAME}=invalid; ${guest.cookie}`;
    expect((await get(api, invalidCookie, "/games/history")).statusCode).toBe(401);
    await api.database.db
      .update(authSchema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSchema.session.id, secondSession.principal.sessionId));
    expect((await get(secondApi, secondSession.cookie, "/games/history")).statusCode).toBe(401);
  });

  it("paginates equal and sub-millisecond timestamps without gaps while new games finish", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const finished = [];
    for (let index = 0; index < 5; index++) finished.push(await terminal(api, owner.cookie));
    const timestamp = "2026-09-01T12:00:00.123456Z";
    for (const snapshot of finished) {
      await api.database.db
        .update(games)
        .set({ updatedAt: sql`${timestamp}::timestamptz` })
        .where(eq(games.id, snapshot.gameId));
    }
    const newest = finished[0]!;
    await api.database.db
      .update(games)
      .set({ updatedAt: sql`'2026-09-01T12:00:00.123457Z'::timestamptz` })
      .where(eq(games.id, newest.gameId));
    const expected = [
      newest.gameId,
      ...finished
        .slice(1)
        .map((game) => game.gameId)
        .sort()
        .reverse(),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await get(
        api,
        owner.cookie,
        "/games/history?limit=2" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
      expect(response.statusCode).toBe(200);
      const page = gameHistoryPageSchema.parse(response.json());
      seen.push(...page.games.map((game) => game.gameId));
      if (cursor === null) await terminal(api, owner.cookie);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(expected);
    for (const query of [
      "limit=51",
      "limit=0",
      "limit=2&limit=3",
      "cursor=broken",
      "ownerUserId=someone",
      "state=active",
    ]) {
      expect((await get(api, owner.cookie, "/games/history?" + query)).statusCode).toBe(400);
    }
    const empty = await harness.account(api);
    expect((await get(api, empty.cookie, "/games/history")).json()).toEqual({
      games: [],
      nextCursor: null,
    });
  });
});
