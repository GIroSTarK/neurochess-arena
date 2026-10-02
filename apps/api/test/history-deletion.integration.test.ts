import { randomUUID } from "node:crypto";

import {
  gameDetailsSchema,
  gameHistoryResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  type NormalizedMoveResponse,
} from "@neurochess/contracts";
import {
  aiControllers,
  aiTurnReservations,
  aiTurns,
  authSessions,
  authUsers,
  gameCommands,
  gameParticipants,
  games,
  modelInvocations,
  moves,
  profiles,
  providerCredentials,
} from "@neurochess/database";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { control, gatedAdapter, humanMatch, output, turnCommand } from "./ai-turn-helpers.js";
import { command, createSandbox, type TestApi, WEB_ORIGIN } from "./helpers.js";
import { withTurnCatalog } from "./providers/turn-catalog.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

const invalidOutput: NormalizedMoveResponse = {
  ok: false,
  error: { code: "model_invalid", reason: "illegal_move" },
  durationMs: 1,
  usage: null,
  providerRequestId: null,
};

// Every AI turn records a rejected attempt before its accepted move and commentary.
function aiApi(options: Parameters<AccountGameHarness["createAuthenticatedApi"]>[0] = {}) {
  let calls = 0;
  return harness.createAuthenticatedApi({
    ...options,
    aiAdapters: {
      openai: withTurnCatalog({
        provider: "openai",
        listModels: () => Promise.reject(new Error("Catalog supplied by the fixture wrapper")),
        requestMove: async () =>
          calls++ % 2 === 0 ? invalidOutput : output("e2e4", "Deleted commentary canary"),
      }),
    },
  });
}

function deleteGame(api: TestApi, cookie: string, gameId: string) {
  return harness.post(api, cookie, "/games/history/delete", { gameId });
}

function clearHistory(api: TestApi, cookie: string) {
  return harness.post(api, cookie, "/games/history/clear", { confirm: true });
}

async function historyIds(api: TestApi, cookie: string) {
  const response = await api.app.inject({ url: "/games/history", headers: { cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return gameHistoryResponseSchema.parse(response.json()).games.map((game) => game.gameId);
}

async function accepted(response: Promise<{ statusCode: number; body: string; json(): unknown }>) {
  const result = await response;
  expect(result.statusCode, result.body).toBe(200);
  return gameSnapshotSchema.parse(result.json());
}

function lifecycle(
  api: TestApi,
  cookie: string,
  snapshot: GameSnapshot,
  action: "pause" | "abort" | "resign",
) {
  return accepted(
    harness.post(api, cookie, `/games/${snapshot.gameId}/lifecycle`, {
      ...control(snapshot, action === "resign" ? "abort" : action),
      // A recovery pause omits the controller so that no live lease remains.
      controllerId: action === "abort" ? snapshot.gameId : undefined,
      ...(action === "resign" ? { action, losingColor: "black" } : {}),
    }),
  );
}

async function terminal(api: TestApi, cookie: string) {
  const { snapshot } = await harness.createGame(api, cookie, humanMatch);
  return lifecycle(api, cookie, snapshot, "abort");
}

// Produces participants, AI and human moves, receipts, a logical turn and two attempts.
async function playedGame(api: TestApi, cookie: string, finish: "abort" | "resign" | "pause") {
  const { snapshot: created } = await harness.createGame(api, cookie, humanMatch);
  await accepted(
    harness.post(api, cookie, `/games/${created.gameId}/controller`, {
      gameId: created.gameId,
      controllerId: created.gameId,
      expectedVersion: created.version,
      action: "acquire",
    }),
  );
  const aiMoved = await accepted(
    harness.post(api, cookie, `/games/${created.gameId}/ai-turn`, {
      ...turnCommand(created),
      apiKey: "fixture-key",
    }),
  );
  const humanMoved = await accepted(
    harness.post(api, cookie, `/games/${created.gameId}/moves`, command(aiMoved, "e7e5")),
  );
  return lifecycle(api, cookie, humanMoved, finish);
}

// Terminal games normally release these rows; fixtures prove the deletion boundary covers them.
async function executionFixtures(api: TestApi, snapshot: GameSnapshot) {
  await api.database.db.insert(aiTurnReservations).values({
    gameId: snapshot.gameId,
    reservationId: randomUUID(),
    commandId: randomUUID(),
    expectedVersion: snapshot.version,
    state: "blocked",
  });
  await api.database.db.insert(aiControllers).values({
    gameId: snapshot.gameId,
    controllerId: randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

async function stored(api: TestApi, gameIds: readonly string[]) {
  const { db } = api.database;
  const ids = gameIds.map((id) => id.toLowerCase());
  const turns = await db
    .select()
    .from(aiTurns)
    .where(inArray(aiTurns.gameId, ids))
    .orderBy(asc(aiTurns.id));
  return {
    games: await db.select().from(games).where(inArray(games.id, ids)).orderBy(asc(games.id)),
    participants: await db
      .select()
      .from(gameParticipants)
      .where(inArray(gameParticipants.gameId, ids))
      .orderBy(asc(gameParticipants.id)),
    moves: await db
      .select()
      .from(moves)
      .where(inArray(moves.gameId, ids))
      .orderBy(asc(moves.gameId), asc(moves.ply)),
    commands: await db
      .select()
      .from(gameCommands)
      .where(inArray(gameCommands.gameId, ids))
      .orderBy(asc(gameCommands.gameId), asc(gameCommands.version)),
    turns,
    invocations: turns.length
      ? await db
          .select()
          .from(modelInvocations)
          .where(
            inArray(
              modelInvocations.turnId,
              turns.map((turn) => turn.id),
            ),
          )
          .orderBy(asc(modelInvocations.id))
      : [],
    reservations: await db
      .select()
      .from(aiTurnReservations)
      .where(inArray(aiTurnReservations.gameId, ids))
      .orderBy(asc(aiTurnReservations.gameId)),
    controllers: await db
      .select()
      .from(aiControllers)
      .where(inArray(aiControllers.gameId, ids))
      .orderBy(asc(aiControllers.gameId)),
  };
}

// Attempts are found through their turns, so also check the attempt IDs captured before deletion.
async function expectDeleted(
  api: TestApi,
  gameIds: readonly string[],
  before: Awaited<ReturnType<typeof stored>>,
) {
  expect(await stored(api, gameIds)).toEqual({
    games: [],
    participants: [],
    moves: [],
    commands: [],
    turns: [],
    invocations: [],
    reservations: [],
    controllers: [],
  });
  const attempts = before.invocations.map((attempt) => attempt.id);
  if (attempts.length) {
    expect(
      await api.database.db.$count(modelInvocations, inArray(modelInvocations.id, attempts)),
    ).toBe(0);
  }
}

async function accountData(api: TestApi, userId: string) {
  const { db } = api.database;
  return {
    user: await db.select().from(authUsers).where(eq(authUsers.id, userId)),
    sessions: await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, userId))
      .orderBy(asc(authSessions.id)),
    profile: await db.select().from(profiles).where(eq(profiles.userId, userId)),
    credentials: await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId))
      .orderBy(asc(providerCredentials.id)),
  };
}

async function saveCredential(api: TestApi, cookie: string) {
  const response = await harness.post(api, cookie, "/credentials", {
    credentialId: randomUUID(),
    save: true,
    provider: "openai",
    label: "Kept key",
    apiKey: "kept-fixture-key-1234",
  });
  expect(response.statusCode, response.body).toBe(201);
}

// Hold the account row so queued requests acquire it in a known order once released.
async function queued(
  api: TestApi,
  userId: string,
  operations: readonly (() => ReturnType<typeof harness.post>)[],
) {
  const started: ReturnType<typeof harness.post>[] = [];
  await api.database.db.transaction(async (tx) => {
    const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    await tx.select().from(authUsers).where(eq(authUsers.id, userId)).for("update");
    for (const operation of operations) {
      started.push(operation());
      await expect
        .poll(async () => {
          await tx.execute(sql`select pg_stat_clear_snapshot()`);
          const waiting = await tx.execute<{ count: number }>(sql`
            with recursive blocked as (
              select pid from pg_stat_activity where ${result.rows[0]!.pid} = any(pg_blocking_pids(pid))
              union
              select activity.pid from pg_stat_activity activity
                join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
            ) select count(*)::int as count from blocked`);
          return waiting.rows[0]!.count;
        })
        .toBe(started.length);
    }
  });
  return Promise.all(started);
}

describe("account history deletion", () => {
  it("deletes one terminal game with every dependent record while preserving other data", async () => {
    const api = await aiApi();
    const owner = await harness.account(api);
    const second = await owner.anotherSession();
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    const doomed = await playedGame(api, owner.cookie, "abort");
    const kept = await playedGame(api, owner.cookie, "resign");
    const unfinished = await playedGame(api, owner.cookie, "pause");
    const foreign = await playedGame(api, other.cookie, "abort");
    const guestGame = await terminal(api, guest.cookie);
    const sandbox = await createSandbox(api, guest);
    await executionFixtures(api, doomed);
    await saveCredential(api, owner.cookie);
    const doomedRecords = await stored(api, [doomed.gameId]);
    expect(doomedRecords.moves).toHaveLength(2);
    expect(doomedRecords.commands).toHaveLength(3);
    expect(doomedRecords.turns).toHaveLength(1);
    expect(doomedRecords.invocations.map((attempt) => attempt.outcome)).toEqual(
      expect.arrayContaining(["model_invalid", "accepted"]),
    );
    expect(doomedRecords.reservations).toHaveLength(1);
    expect(doomedRecords.controllers).toHaveLength(1);
    const keptIds = [kept, unfinished, foreign, guestGame, sandbox].map((game) => game.gameId);
    const keptBefore = await stored(api, keptIds);
    const ownerBefore = await accountData(api, owner.principal.userId);
    expect(await historyIds(api, owner.cookie)).toEqual([kept.gameId, doomed.gameId]);

    const response = await deleteGame(api, second.cookie, doomed.gameId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: "deleted" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();

    await expectDeleted(api, [doomed.gameId], doomedRecords);
    expect(await stored(api, keptIds)).toEqual(keptBefore);
    expect(await accountData(api, owner.principal.userId)).toEqual(ownerBefore);
    expect(await historyIds(api, owner.cookie)).toEqual([kept.gameId]);
    for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
      const read = await api.app.inject({
        url: `/games/${doomed.gameId}${suffix}`,
        headers: { cookie: owner.cookie },
      });
      expect(read.statusCode, suffix).toBe(404);
      expect(read.body).not.toContain("canary");
    }
    for (const [path, body] of [
      ["lifecycle", { ...control(doomed, "pause"), controllerId: undefined }],
      ["moves", command(doomed, "g1f3")],
      ["ai-turn", { ...turnCommand(doomed), apiKey: "fixture-key" }],
    ] as const) {
      const recreated = await harness.post(
        api,
        owner.cookie,
        `/games/${doomed.gameId}/${path}`,
        body,
      );
      expect(recreated.statusCode, path).toBe(404);
    }
    expect(await api.database.db.$count(games, eq(games.id, doomed.gameId))).toBe(0);
    const unchanged = await api.app.inject({
      url: `/games/${unfinished.gameId}`,
      headers: { cookie: owner.cookie },
    });
    expect(gameSnapshotSchema.parse(unchanged.json())).toEqual(unfinished);
  });

  it("acknowledges repeated, absent and foreign IDs without disclosing or changing other games", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    const own = await terminal(api, owner.cookie);
    const foreign = await terminal(api, other.cookie);
    const guestGame = await terminal(api, guest.cookie);
    const sandbox = await lifecycle(api, guest.cookie, await createSandbox(api, guest), "abort");
    const keptIds = [foreign, guestGame, sandbox].map((game) => game.gameId);
    const before = await stored(api, keptIds);
    for (const [cookie, gameId] of [
      [owner.cookie, foreign.gameId],
      [owner.cookie, foreign.gameId.toUpperCase()],
      [owner.cookie, guestGame.gameId],
      [`${owner.cookie}; ${guest.cookie}`, guestGame.gameId],
      [`${owner.cookie}; ${guest.cookie}`, sandbox.gameId],
      [owner.cookie, randomUUID()],
      [owner.cookie, own.gameId.toUpperCase()],
      [owner.cookie, own.gameId],
    ] as const) {
      const response = await deleteGame(api, cookie, gameId);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ status: "deleted" });
    }
    expect(await stored(api, keptIds)).toEqual(before);
    expect(await api.database.db.$count(games, eq(games.id, own.gameId))).toBe(0);
    expect(await historyIds(api, owner.cookie)).toEqual([]);
    expect(await historyIds(api, other.cookie)).toEqual([foreign.gameId]);
    for (const [cookie, snapshot] of [
      [other.cookie, foreign],
      [guest.cookie, guestGame],
      [guest.cookie, sandbox],
    ] as const) {
      const read = await api.app.inject({
        url: `/games/${snapshot.gameId}/pgn`,
        headers: { cookie },
      });
      expect(read.statusCode, read.body).toBe(200);
    }
  });

  it("refuses unfinished games and clears only the account's terminal history", async () => {
    const api = await aiApi();
    const owner = await harness.account(api);
    const second = await owner.anotherSession();
    const other = await harness.account(api);
    const aborted = await playedGame(api, owner.cookie, "abort");
    const resigned = await playedGame(api, owner.cookie, "resign");
    const { snapshot: active } = await harness.createGame(api, owner.cookie, humanMatch);
    const activeRejected = await deleteGame(api, owner.cookie, active.gameId);
    expect(activeRejected.statusCode).toBe(409);
    expect(activeRejected.json()).toMatchObject({ code: "INVALID_GAME_STATE" });
    expect(activeRejected.json()).not.toHaveProperty("currentSnapshot");
    const paused = await lifecycle(api, owner.cookie, active, "pause");
    const pausedRejected = await deleteGame(api, second.cookie, paused.gameId);
    expect(pausedRejected.statusCode).toBe(409);
    expect(pausedRejected.json()).toMatchObject({ code: "INVALID_GAME_STATE" });
    const foreign = await terminal(api, other.cookie);
    await saveCredential(api, owner.cookie);
    const keptIds = [paused.gameId, foreign.gameId];
    const keptBefore = await stored(api, keptIds);
    const clearedIds = [aborted.gameId, resigned.gameId];
    const clearedBefore = await stored(api, clearedIds);
    expect(clearedBefore.invocations).toHaveLength(4);
    await executionFixtures(api, aborted);
    const ownerBefore = await accountData(api, owner.principal.userId);
    const otherBefore = await accountData(api, other.principal.userId);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await clearHistory(api, second.cookie);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ status: "deleted" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    await expectDeleted(api, clearedIds, clearedBefore);
    expect(await stored(api, keptIds)).toEqual(keptBefore);
    expect(await accountData(api, owner.principal.userId)).toEqual(ownerBefore);
    expect(await accountData(api, other.principal.userId)).toEqual(otherBefore);
    expect(await historyIds(api, owner.cookie)).toEqual([]);
    expect(await historyIds(api, other.cookie)).toEqual([foreign.gameId]);
    const unfinished = await api.app.inject({
      url: "/games/unfinished",
      headers: { cookie: owner.cookie },
    });
    expect(unfinished.json()).toMatchObject({ game: { snapshot: paused } });
  });

  it("requires a valid account session, completed profile, exact origin and strict bodies", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const incomplete = await harness.account(api, false);
    const guest = await harness.guest(api);
    const game = await terminal(api, owner.cookie);
    const guestGame = await terminal(api, guest.cookie);
    const requests = [
      ["/games/history/delete", { gameId: guestGame.gameId }],
      ["/games/history/clear", { confirm: true }],
    ] as const;
    for (const [url, payload] of requests) {
      for (const cookie of [
        "",
        guest.cookie,
        "__Secure-neurochess.session_token=forged-canary",
        `__Secure-neurochess.session_token=forged-canary; ${guest.cookie}`,
      ]) {
        const response = await harness.post(api, cookie, url, payload);
        expect(response.statusCode, `${url} ${cookie}`).toBe(401);
        expect(response.body).not.toContain("canary");
      }
      const unfinishedProfile = await harness.post(api, incomplete.cookie, url, payload);
      expect(unfinishedProfile.statusCode).toBe(403);
      expect(unfinishedProfile.json()).toMatchObject({ code: "PROFILE_REQUIRED" });
      for (const headers of [
        { "x-neurochess-expected-account": randomUUID() },
        { "x-neurochess-expected-account": "guest" },
      ]) {
        const stale = await api.app.inject({
          method: "POST",
          url,
          payload,
          headers: { origin: WEB_ORIGIN, cookie: owner.cookie, ...headers },
        });
        expect(stale.statusCode).toBe(401);
      }
      const invalidIntent = await api.app.inject({
        method: "POST",
        url,
        payload,
        headers: { origin: WEB_ORIGIN, cookie: owner.cookie, "x-neurochess-identity": "admin" },
      });
      expect(invalidIntent.statusCode).toBe(400);
      for (const origin of [undefined, "https://evil.example"]) {
        const response = await api.app.inject({
          method: "POST",
          url,
          payload,
          headers: { cookie: owner.cookie, ...(origin ? { origin } : {}) },
        });
        expect(response.statusCode).toBe(403);
      }
      const query = await harness.post(api, owner.cookie, `${url}?gameId=${game.gameId}`, payload);
      expect(query.statusCode).toBe(400);
    }
    for (const payload of [
      {},
      { gameId: "not-a-game" },
      { gameId: [game.gameId] },
      { gameId: game.gameId, ownerUserId: owner.principal.userId },
      { gameId: game.gameId, all: true },
    ]) {
      const response = await harness.post(api, owner.cookie, "/games/history/delete", payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    for (const payload of [
      {},
      { confirm: false },
      { confirm: "true" },
      { confirm: true, userId: owner.principal.userId },
    ]) {
      const response = await harness.post(api, owner.cookie, "/games/history/clear", payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await historyIds(api, owner.cookie)).toEqual([game.gameId]);
    expect(
      (
        await api.app.inject({
          url: `/games/${guestGame.gameId}`,
          headers: { cookie: guest.cookie },
        })
      ).statusCode,
    ).toBe(200);
    await harness.post(api, owner.cookie, "/api/auth/sign-out", {});
    for (const [url, payload] of requests) {
      const signedOut = await harness.post(api, `${owner.cookie}; ${guest.cookie}`, url, payload);
      expect(signedOut.statusCode).toBe(401);
    }
    expect(await api.database.db.$count(games, eq(games.id, game.gameId))).toBe(1);
    expect(await api.database.db.$count(games, eq(games.id, guestGame.gameId))).toBe(1);
  });

  it.each(["failure", "session expiry"] as const)(
    "rolls back deletion and clearing after a %s following the delete statement",
    async (interruption) => {
      const hooks: { afterDelete?: (() => Promise<void>) | undefined } = {};
      const api = await aiApi({
        repository: (repository) => ({
          ...repository,
          write: (action) =>
            repository.write((tx) =>
              action({
                ...tx,
                async deleteAccountHistoryGame(userId, gameId) {
                  const deleted = await tx.deleteAccountHistoryGame(userId, gameId);
                  await hooks.afterDelete?.();
                  return deleted;
                },
                async clearAccountHistory(userId) {
                  await tx.clearAccountHistory(userId);
                  await hooks.afterDelete?.();
                },
              }),
            ),
        }),
      });
      const owner = await harness.account(api);
      const game = await playedGame(api, owner.cookie, "abort");
      const before = await stored(api, [game.gameId]);
      for (const request of [
        () => deleteGame(api, owner.cookie, game.gameId),
        () => clearHistory(api, owner.cookie),
      ]) {
        hooks.afterDelete = async () => {
          expect(
            await api.database.db.$count(games, eq(games.id, game.gameId)),
            "uncommitted deletion is invisible to other connections",
          ).toBe(1);
          if (interruption === "failure") throw new Error("Injected failure after deletion");
          await api.database.db
            .update(authSessions)
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where(eq(authSessions.id, owner.principal.sessionId));
        };
        const response = await request();
        expect(response.statusCode).toBe(interruption === "failure" ? 500 : 401);
        expect(response.body).not.toContain("Injected");
        expect(await stored(api, [game.gameId])).toEqual(before);
        await api.database.db
          .update(authSessions)
          .set({ expiresAt: new Date(Date.now() + 3_600_000) })
          .where(eq(authSessions.id, owner.principal.sessionId));
      }
      hooks.afterDelete = undefined;
      expect((await deleteGame(api, owner.cookie, game.gameId)).statusCode).toBe(200);
      expect(await historyIds(api, owner.cookie)).toEqual([]);
    },
  );

  it("serializes clearing with completion, creation and deletion across API instances", async () => {
    const api = await harness.createAuthenticatedApi();
    const otherApi = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const second = await account.anotherSession();
    const clear = () => clearHistory(api, account.cookie);
    for (const completeFirst of [true, false]) {
      const finished = await terminal(api, account.cookie);
      const { snapshot } = await harness.createGame(api, account.cookie, humanMatch);
      const complete = () =>
        harness.post(
          otherApi,
          second.cookie,
          `/games/${snapshot.gameId}/lifecycle`,
          control(snapshot, "abort"),
        );
      const responses = await queued(
        api,
        account.principal.userId,
        completeFirst ? [complete, clear] : [clear, complete],
      );
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      // Clearing removes the games finished when it acquires the account; later results remain.
      expect(await historyIds(api, account.cookie)).toEqual(completeFirst ? [] : [snapshot.gameId]);
      expect(await api.database.db.$count(games, eq(games.id, finished.gameId))).toBe(0);
      await clear();
    }
    for (const createFirst of [true, false]) {
      const finished = await terminal(api, account.cookie);
      const create = () => harness.post(otherApi, second.cookie, "/games", humanMatch);
      const responses = await queued(
        api,
        account.principal.userId,
        createFirst ? [create, clear] : [clear, create],
      );
      expect(responses.map((response) => response.statusCode)).toEqual(
        createFirst ? [201, 200] : [200, 201],
      );
      const created = gameDetailsSchema.parse(
        responses.at(createFirst ? 0 : 1)?.json<unknown>(),
      ).snapshot;
      expect(await api.database.db.$count(games, eq(games.id, finished.gameId))).toBe(0);
      expect(
        gameSnapshotSchema.parse(
          (
            await api.app.inject({
              url: `/games/${created.gameId}`,
              headers: { cookie: account.cookie },
            })
          ).json(),
        ),
      ).toEqual(created);
      await lifecycle(api, account.cookie, created, "abort");
      await clear();
    }
    const target = await terminal(api, account.cookie);
    const kept = await terminal(api, account.cookie);
    const responses = await queued(api, account.principal.userId, [
      () => deleteGame(otherApi, second.cookie, target.gameId),
      () => deleteGame(api, account.cookie, target.gameId),
    ]);
    expect(responses.map((response) => response.json<unknown>())).toEqual([
      { status: "deleted" },
      { status: "deleted" },
    ]);
    expect(await historyIds(api, account.cookie)).toEqual([kept.gameId]);
  });

  it("gives a racing read either the complete pre-deletion game or no game", async () => {
    const api = await aiApi();
    const owner = await harness.account(api);
    const game = await playedGame(api, owner.cookie, "abort");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const service = createGameService(
      {
        ...api.repository,
        read: (action) =>
          api.repository.read((reader) =>
            action({
              ...reader,
              async getMoves(gameId) {
                entered.resolve();
                await release.promise;
                return reader.getMoves(gameId);
              },
            }),
          ),
      },
      { nodeEnv: "test", sandboxEnabled: true },
    );
    const reading = service.details(owner.principal, game.gameId);
    await entered.promise;
    try {
      expect((await deleteGame(api, owner.cookie, game.gameId)).statusCode).toBe(200);
    } finally {
      release.resolve();
    }
    expect((await reading).snapshot).toEqual(game);
    await expect(service.details(owner.principal, game.gameId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("never lets a late provider outcome recreate a stopped game deleted mid-dispatch", async () => {
    const gate = gatedAdapter();
    const api = await harness.createAuthenticatedApi({
      aiAdapters: { openai: withTurnCatalog(gate.adapter) },
    });
    const owner = await harness.account(api);
    const { snapshot } = await harness.createGame(api, owner.cookie, humanMatch);
    await accepted(
      harness.post(api, owner.cookie, `/games/${snapshot.gameId}/controller`, {
        gameId: snapshot.gameId,
        controllerId: snapshot.gameId,
        expectedVersion: snapshot.version,
        action: "acquire",
      }),
    );
    const pending = harness.post(api, owner.cookie, `/games/${snapshot.gameId}/ai-turn`, {
      ...turnCommand(snapshot),
      apiKey: "fixture-key",
    });
    await gate.entered;
    let stopped: Awaited<ReturnType<typeof stored>> | undefined;
    try {
      expect((await lifecycle(api, owner.cookie, snapshot, "abort")).state).toBe("aborted");
      stopped = await stored(api, [snapshot.gameId]);
      expect(stopped.invocations.map((attempt) => attempt.outcome)).toEqual(["interrupted"]);
      expect((await deleteGame(api, owner.cookie, snapshot.gameId)).statusCode).toBe(200);
    } finally {
      gate.resolve(output("e2e4", "Late commentary canary"));
    }
    const late = await pending;
    expect(late.statusCode).toBe(404);
    expect(late.body).not.toContain("canary");
    await expectDeleted(api, [snapshot.gameId], stopped);
    expect(
      await api.database.db.$count(
        modelInvocations,
        eq(modelInvocations.commentary, "Late commentary canary"),
      ),
    ).toBe(0);
  });
});
