import { randomUUID } from "node:crypto";

import { type GameSnapshot, gameSnapshotSchema } from "@neurochess/contracts";
import {
  aiControllers,
  aiTurnReservations,
  authSessions,
  authUsers,
  gameCommands,
  games,
  moves,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { control, gatedAdapter, output, turnCommand } from "./ai-turn-helpers.js";
import { command, type TestApi } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { withTurnCatalog } from "./providers/turn-catalog.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

async function claim(
  api: TestApi,
  cookie: string,
  snapshot: GameSnapshot,
  controllerId = snapshot.gameId,
) {
  const response = await harness.post(api, cookie, `/games/${snapshot.gameId}/controller`, {
    gameId: snapshot.gameId,
    controllerId,
    expectedVersion: snapshot.version,
    action: "acquire",
  });
  expect(response.statusCode, response.body).toBe(200);
  return controllerId;
}

async function lifecycle(
  api: TestApi,
  cookie: string,
  snapshot: GameSnapshot,
  action: "pause" | "resume" | "abort",
  controllerId?: string,
) {
  const response = await harness.post(api, cookie, `/games/${snapshot.gameId}/lifecycle`, {
    ...control(snapshot, action),
    controllerId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return gameSnapshotSchema.parse(response.json());
}

describe("account recovery and session fences", () => {
  it("recovers on another device through an explicit pause, discards late work, and requires a new controller", async () => {
    const gate = gatedAdapter();
    const api = await harness.createAuthenticatedApi({
      aiAdapters: { openai: withTurnCatalog(gate.adapter) },
    });
    const other = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const second = await owner.anotherSession();
    const { snapshot } = await harness.createGame(api, owner.cookie);
    await claim(api, owner.cookie, snapshot);
    const pending = harness.post(api, owner.cookie, `/games/${snapshot.gameId}/ai-turn`, {
      ...turnCommand(snapshot),
      apiKey: "fixture-key",
    });
    await gate.entered;
    try {
      const read = await other.app.inject({
        url: `/games/${snapshot.gameId}`,
        headers: { cookie: second.cookie },
      });
      expect(read.json()).toMatchObject({ state: "active", version: 0 });
      const paused = await lifecycle(other, second.cookie, snapshot, "pause");
      expect(paused).toMatchObject({ state: "paused", version: 1, moves: [] });
      const heartbeat = await harness.post(
        api,
        owner.cookie,
        `/games/${snapshot.gameId}/controller`,
        { gameId: snapshot.gameId, controllerId: snapshot.gameId, action: "heartbeat" },
      );
      expect(heartbeat.json()).toMatchObject({ code: "AI_CONTROLLER_LOST" });
      gate.resolve(output("e2e4"));
      expect((await pending).statusCode).toBe(409);
      const missingController = await harness.post(
        other,
        second.cookie,
        `/games/${snapshot.gameId}/lifecycle`,
        control(paused, "resume"),
      );
      expect(missingController.json()).toMatchObject({ code: "AI_CONTROLLER_LOST" });
      const controller = await claim(other, second.cookie, paused, randomUUID());
      const resumed = await lifecycle(other, second.cookie, paused, "resume", controller);
      expect(resumed).toMatchObject({ state: "active", moves: [], version: 2 });
      expect(
        (
          await other.app.inject({
            url: `/games/${snapshot.gameId}/invocations`,
            headers: { cookie: second.cookie },
          })
        ).body,
      ).toContain('"outcome":"discarded"');
    } finally {
      gate.resolve(output("e2e4"));
      await pending;
    }
  });

  it.each(["sign-out", "expiry"] as const)(
    "rejects a late outcome after %s while another session remains valid",
    async (ending) => {
      const gate = gatedAdapter();
      const api = await harness.createAuthenticatedApi({
        aiAdapters: { openai: withTurnCatalog(gate.adapter) },
      });
      const owner = await harness.account(api);
      const second = await owner.anotherSession();
      const { snapshot } = await harness.createGame(api, owner.cookie);
      await claim(api, owner.cookie, snapshot);
      const pending = harness.post(api, owner.cookie, `/games/${snapshot.gameId}/ai-turn`, {
        ...turnCommand(snapshot),
        apiKey: "fixture-key",
      });
      await gate.entered;
      try {
        if (ending === "sign-out") {
          expect((await harness.post(api, owner.cookie, "/api/auth/sign-out", {})).statusCode).toBe(
            200,
          );
        } else {
          await api.database.db
            .update(authSessions)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(authSessions.id, owner.principal.sessionId));
        }
        gate.resolve(output("e2e4"));
        expect((await pending).statusCode).toBe(401);
        const read = await api.app.inject({
          url: `/games/${snapshot.gameId}`,
          headers: { cookie: second.cookie },
        });
        expect(read.json()).toMatchObject({ version: 0, moves: [] });
        const heartbeat = await harness.post(
          api,
          owner.cookie,
          `/games/${snapshot.gameId}/controller`,
          { gameId: snapshot.gameId, controllerId: snapshot.gameId, action: "heartbeat" },
        );
        expect(heartbeat.statusCode).toBe(401);
        const [reservation] = await api.database.db
          .select()
          .from(aiTurnReservations)
          .where(eq(aiTurnReservations.gameId, snapshot.gameId));
        expect(reservation?.state).toBe("blocked");
        expect((await lifecycle(api, second.cookie, snapshot, "pause")).state).toBe("paused");
      } finally {
        gate.resolve(output("e2e4"));
        await pending;
      }
    },
  );

  it.each(["identity", "game"] as const)(
    "rechecks account session validity after waiting for the %s lock",
    async (lock) => {
      const locking = Promise.withResolvers<void>();
      const api = await harness.createAuthenticatedApi();
      const account = await harness.account(api);
      const { snapshot } = await harness.createGame(api, account.cookie);
      const service = createGameService(
        {
          ...api.repository,
          write: (action) =>
            api.repository.write((tx) =>
              action({
                ...tx,
                lockAccount: (id) => {
                  if (lock === "identity") locking.resolve();
                  return tx.lockAccount(id);
                },
                lockGame: (id) => {
                  if (lock === "game") locking.resolve();
                  return tx.lockGame(id);
                },
              }),
            ),
        },
        { nodeEnv: "test", sandboxEnabled: true },
      );
      let pending: Promise<unknown> | undefined;
      await api.database.db.transaction(async (tx) => {
        if (lock === "identity") {
          await tx
            .select()
            .from(authUsers)
            .where(eq(authUsers.id, account.principal.userId))
            .for("update");
        } else await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
        pending = service
          .lifecycle(account.principal, control(snapshot, "pause"))
          .catch((error: unknown) => error);
        await locking.promise;
        await tx
          .update(authSessions)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(authSessions.id, account.principal.sessionId));
      });
      expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
      expect(
        await api.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
      ).toBe(0);
    },
  );

  it("pauses abandoned account games on API startup even when all sessions have expired", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const { snapshot } = await harness.createGame(api, account.cookie);
    await harness.close(api);
    const other = await harness.createAuthenticatedApi();
    await other.database.db
      .delete(authSessions)
      .where(eq(authSessions.userId, account.principal.userId));
    await other.database.db
      .update(aiControllers)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(aiControllers.gameId, snapshot.gameId));
    await other.app.ready();
    const [stored] = await other.database.db
      .select()
      .from(games)
      .where(eq(games.id, snapshot.gameId));
    expect(stored).toMatchObject({
      state: "paused",
      version: 1,
      fen: snapshot.fen,
      pgn: snapshot.pgn,
    });
    expect(
      await other.database.db.$count(aiControllers, eq(aiControllers.gameId, snapshot.gameId)),
    ).toBe(0);
    expect(
      await other.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
    ).toBe(1);
  });

  it("restores full repetition history across devices and keeps terminal replay private after the slot is released", async () => {
    const api = await harness.createAuthenticatedApi({
      aiAdapters: {
        openai: withTurnCatalog(
          createScriptedAdapter({
            provider: "openai",
            moves: ["g1f3", "f3g1", "g1f3", "f3g1"].map((move) => output(move)),
          }),
        ),
        anthropic: withTurnCatalog(
          createScriptedAdapter({
            provider: "anthropic",
            moves: ["g8f6", "f6g8", "g8f6", "f6g8"].map((move) => output(move)),
          }),
        ),
      },
    });
    const account = await harness.account(api);
    const second = await account.anotherSession();
    let { snapshot } = await harness.createGame(api, account.cookie);
    const id = snapshot.gameId;
    let cookie = account.cookie;
    let controllerId = await claim(api, cookie, snapshot);
    for (let ply = 0; ply < 8; ply++) {
      if (ply === 4) {
        cookie = second.cookie;
        snapshot = await lifecycle(api, cookie, snapshot, "pause");
        controllerId = await claim(api, cookie, snapshot, randomUUID());
        snapshot = await lifecycle(api, cookie, snapshot, "resume", controllerId);
      }
      const move = { ...turnCommand(snapshot), controllerId, apiKey: "fixture-key" };
      const response = await harness.post(api, cookie, `/games/${id}/ai-turn`, move);
      expect(response.statusCode, response.body).toBe(200);
      snapshot = gameSnapshotSchema.parse(response.json());
      const duplicate = await harness.post(api, cookie, `/games/${id}/ai-turn`, move);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: snapshot });
    }
    expect(snapshot).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "threefold_repetition",
    });
    expect(await api.database.db.$count(moves, eq(moves.gameId, id))).toBe(8);
    await harness.createGame(api, cookie);
    expect(
      (await api.app.inject({ url: `/games/${id}/replay`, headers: { cookie } })).json(),
    ).toMatchObject({ snapshot });
    expect((await api.app.inject({ url: `/games/${id}/pgn`, headers: { cookie } })).json()).toEqual(
      { gameId: id, version: snapshot.version, pgn: snapshot.pgn },
    );
  });

  it.each(["white", "black"] as const)(
    "assigns only the selected %s human seat to the account",
    async (color) => {
      const api = await harness.createAuthenticatedApi({
        aiAdapters: {
          openai: withTurnCatalog(
            createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] }),
          ),
        },
      });
      const account = await harness.account(api);
      const ai = { type: "ai", provider: "openai", modelId: "fixture-white", parameters: {} };
      let { snapshot } = await harness.createGame(api, account.cookie, {
        mode: "ai_vs_human",
        seats: {
          white: color === "white" ? { type: "human" } : ai,
          black: color === "black" ? { type: "human" } : ai,
        },
      });
      await claim(api, account.cookie, snapshot);
      if (color === "black") {
        const response = await harness.post(
          api,
          account.cookie,
          `/games/${snapshot.gameId}/ai-turn`,
          { ...turnCommand(snapshot), apiKey: "fixture-key" },
        );
        expect(response.statusCode, response.body).toBe(200);
        snapshot = gameSnapshotSchema.parse(response.json());
      }
      const accepted = await harness.post(
        api,
        account.cookie,
        `/games/${snapshot.gameId}/moves`,
        command(snapshot, color === "white" ? "e2e4" : "e7e5"),
      );
      expect(accepted.statusCode, accepted.body).toBe(200);
      snapshot = gameSnapshotSchema.parse(accepted.json());
      const denied = await harness.post(
        api,
        account.cookie,
        `/games/${snapshot.gameId}/moves`,
        command(snapshot, color === "white" ? "e7e5" : "g1f3"),
      );
      expect(denied.statusCode).toBe(403);
      const resigned = await harness.post(
        api,
        account.cookie,
        `/games/${snapshot.gameId}/lifecycle`,
        {
          gameId: snapshot.gameId,
          commandId: randomUUID(),
          expectedVersion: snapshot.version,
          action: "resign",
          losingColor: color,
        },
      );
      expect(resigned.statusCode).toBe(200);
      expect(resigned.json()).toMatchObject({
        state: "completed",
        terminationReason: "human_resignation",
        result: color === "white" ? "0-1" : "1-0",
      });
    },
  );
});
