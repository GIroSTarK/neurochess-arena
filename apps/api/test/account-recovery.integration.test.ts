import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import type { AiGameConfiguration } from "@neurochess/contracts";
import { aiControllers, authSchema, type GameRepository, games } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createAuth } from "../src/auth/service.js";
import { createGameService } from "../src/games/service.js";

import { AccountGameHarness, get, post } from "./account-game-helpers.js";
import {
  access,
  aiMatch,
  control,
  gatedAdapter,
  output,
  service,
  turnCommand,
  whiteAi,
} from "./ai-turn-helpers.js";
import { AUTH_ENVIRONMENT } from "./auth-helpers.js";
import { command, KNIGHT_CYCLE } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { turnCatalog, withTurnCatalog } from "./providers/turn-catalog.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

describe("account recovery and identity fences", () => {
  it("recovers from another device paused, invalidates the old controller and late outcome, and requires explicit continuation", async () => {
    const first = await harness.createApi();
    const second = await harness.createApi();
    const owner = await harness.account(first);
    const nextSession = await harness.anotherSession(second, owner);
    const gate = gatedAdapter();
    const oldService = service(first, { openai: gate.adapter });
    const nextAdapter = createScriptedAdapter({ provider: "openai", moves: [output("d2d4")] });
    const nextService = service(second, { openai: nextAdapter });
    const { snapshot } = await oldService.createAi(owner.principal, aiMatch);
    const pending = oldService
      .aiTurn(owner.principal, turnCommand(snapshot), access())
      .catch((error: unknown) => error);
    await gate.entered;
    try {
      expect(await nextService.details(nextSession.principal, snapshot.gameId)).toMatchObject({
        snapshot,
      });
      const recovery = {
        gameId: snapshot.gameId,
        expectedVersion: snapshot.version,
        commandId: randomUUID(),
        action: "pause" as const,
      };
      const paused = await nextService.lifecycle(nextSession.principal, recovery);
      expect(paused).toMatchObject({ state: "paused", version: 1, moves: [] });
      expect(nextAdapter.moveCalls).toBe(0);
      await expect(
        oldService.controller(owner.principal, {
          gameId: snapshot.gameId,
          controllerId: snapshot.gameId,
          action: "heartbeat",
        }),
      ).rejects.toMatchObject({ code: "AI_CONTROLLER_LOST" });
      const controllerId = randomUUID();
      await nextService.controller(nextSession.principal, {
        gameId: snapshot.gameId,
        expectedVersion: paused.version,
        controllerId,
        action: "acquire",
      });
      await expect(
        oldService.controller(owner.principal, {
          gameId: snapshot.gameId,
          expectedVersion: paused.version,
          controllerId: snapshot.gameId,
          action: "acquire",
        }),
      ).rejects.toMatchObject({ code: "AI_CONTROLLER_BUSY" });
      await expect(
        nextService.aiTurn(
          nextSession.principal,
          { ...turnCommand(paused), controllerId },
          access(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_GAME_STATE" });
      gate.resolve(output("e2e4", "discarded old session"));
      expect(await pending).toMatchObject({ code: "GAME_CONFLICT" });
      const stepped = await nextService.aiTurn(
        nextSession.principal,
        { ...turnCommand(paused), controllerId, step: true },
        access(),
      );
      expect(stepped).toMatchObject({ state: "paused", moves: [{ uci: "d2d4" }] });
      expect(
        await first.repository.read((reader) => reader.getModelInvocations(snapshot.gameId)),
      ).toMatchObject([{ outcome: "discarded", commentary: null }, { outcome: "accepted" }]);
    } finally {
      gate.resolve(output("e2e4"));
      await pending;
    }
  });

  it("restores full account history and repetition counters across recovery and API instances", async () => {
    const first = await harness.createApi();
    const owner = await harness.account(first);
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [...KNIGHT_CYCLE, ...KNIGHT_CYCLE].map((move) => output(move)),
    });
    const gamesService = service(first, { openai: adapter });
    const config: AiGameConfiguration = {
      mode: "ai_vs_ai",
      seats: { white: whiteAi, black: whiteAi },
    };
    let { snapshot } = await gamesService.createAi(owner.principal, config);
    for (let i = 0; i < 4; i++) {
      snapshot = await gamesService.aiTurn(owner.principal, turnCommand(snapshot), access());
    }
    const second = await harness.createApi();
    const returning = await harness.anotherSession(second, owner);
    const restored = service(second, { openai: adapter });
    const recovery = {
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: randomUUID(),
      action: "pause" as const,
    };
    snapshot = await restored.lifecycle(returning.principal, recovery);
    expect(snapshot.moves.map((move) => move.uci)).toEqual(KNIGHT_CYCLE);
    expect(snapshot.legalMoves).toEqual([]);
    const controllerId = randomUUID();
    await restored.controller(returning.principal, {
      gameId: snapshot.gameId,
      controllerId,
      expectedVersion: snapshot.version,
      action: "acquire",
    });
    for (let i = 0; i < 4; i++) {
      snapshot = await restored.aiTurn(
        returning.principal,
        { ...turnCommand(snapshot), controllerId, step: true },
        access(),
      );
    }
    expect(snapshot).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "threefold_repetition",
    });
    expect(snapshot.moves).toHaveLength(8);
    expect(await restored.replay(returning.principal, snapshot.gameId)).toMatchObject({ snapshot });
    expect((await restored.pgn(returning.principal, snapshot.gameId)).pgn).toBe(snapshot.pgn);
  });

  it.each(["identity", "game"] as const)(
    "rechecks account expiry after waiting for the %s lock",
    async (lock) => {
      const api = await harness.createApi();
      const other = await harness.createApi();
      const owner = await harness.account(api);
      const { snapshot } = await service(api).createAi(owner.principal, {
        mode: "ai_vs_human",
        seats: { white: { type: "human" }, black: whiteAi },
      });
      const entering = Promise.withResolvers<void>();
      const order: string[] = [];
      const repository: GameRepository = {
        ...other.repository,
        write: (action) =>
          other.repository.write((tx) =>
            action({
              ...tx,
              async lockAccountSession(userId, sessionId) {
                order.push("identity");
                if (lock === "identity") entering.resolve();
                return tx.lockAccountSession(userId, sessionId);
              },
              async lockGame(id) {
                order.push("game");
                if (lock === "game") entering.resolve();
                return tx.lockGame(id);
              },
            }),
          ),
      };
      const guarded = service(other, {}, repository);
      let pending: Promise<unknown> | undefined;
      await api.database.db.transaction(async (tx) => {
        if (lock === "identity") {
          await tx
            .select()
            .from(authSchema.user)
            .where(eq(authSchema.user.id, owner.userId))
            .for("update");
        } else {
          await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
          // Session revocation is locked during a command; time can still pass at a game lock.
          await api.database.db
            .update(authSchema.session)
            .set({ expiresAt: sql`clock_timestamp() + interval '200 milliseconds'` })
            .where(eq(authSchema.session.id, owner.principal.sessionId));
        }
        pending = guarded
          .move(owner.principal, command(snapshot, "e2e4"))
          .catch((error: unknown) => error);
        await entering.promise;
        if (lock === "identity") {
          await tx
            .delete(authSchema.session)
            .where(eq(authSchema.session.id, owner.principal.sessionId));
        } else {
          await tx.execute(sql`select pg_sleep(0.25)`);
        }
      });
      expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
      expect(order).toEqual(lock === "identity" ? ["identity"] : ["identity", "game"]);
      expect(await api.repository.read((reader) => reader.getMoves(snapshot.gameId))).toEqual([]);
    },
  );

  it("rechecks revocation after a session lock wait before creating an account game", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const entering = Promise.withResolvers<void>();
    const repository: GameRepository = {
      ...api.repository,
      write: (action) =>
        api.repository.write((tx) =>
          action({
            ...tx,
            async lockAccountSession(userId, sessionId) {
              entering.resolve();
              return tx.lockAccountSession(userId, sessionId);
            },
          }),
        ),
    };
    let pending: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx
        .select()
        .from(authSchema.session)
        .where(eq(authSchema.session.id, owner.principal.sessionId))
        .for("update");
      pending = service(api, {}, repository)
        .createAi(owner.principal, aiMatch)
        .catch((error: unknown) => error);
      await entering.promise;
      await tx
        .delete(authSchema.session)
        .where(eq(authSchema.session.id, owner.principal.sessionId));
    });
    expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await api.database.db.$count(games, eq(games.ownerUserId, owner.userId))).toBe(0);
  });

  it.each(["success", "invalid"] as const)(
    "fences late %s after real sign-out and rejects stale service principals",
    async (outcome) => {
      const api = await harness.createApi();
      const owner = await harness.account(api);
      const returning = await harness.anotherSession(api, owner);
      const gate = gatedAdapter();
      const gamesService = service(api, { openai: gate.adapter });
      const { snapshot } = await gamesService.createAi(owner.principal, aiMatch);
      const pending = gamesService
        .aiTurn(owner.principal, turnCommand(snapshot), access())
        .catch((error: unknown) => error);
      await gate.entered;
      try {
        expect((await post(api, owner.cookie, "/api/auth/sign-out", {})).statusCode).toBe(200);
        gate.resolve(
          outcome === "success"
            ? output("e2e4", "late secret")
            : {
                ok: false,
                error: { code: "model_invalid", reason: "illegal_move" },
                durationMs: 1,
                usage: null,
                providerRequestId: null,
              },
        );
        expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
        expect(gate.adapter.moveCalls).toBe(1);
        expect(
          await api.repository.read((reader) => reader.getModelInvocations(snapshot.gameId)),
        ).toMatchObject([{ outcome: "discarded", commentary: null }]);
        expect(
          await api.repository.read((reader) => reader.getAiTurns(snapshot.gameId)),
        ).toMatchObject([{ invalidOutputCount: 0 }]);
        for (const operation of [
          () => gamesService.snapshot(owner.principal, snapshot.gameId),
          () => gamesService.unfinishedGame(owner.principal),
          () => gamesService.details(owner.principal, snapshot.gameId),
          () => gamesService.invocations(owner.principal, snapshot.gameId),
          () => gamesService.pgn(owner.principal, snapshot.gameId),
          () => gamesService.replay(owner.principal, snapshot.gameId),
          () => gamesService.models(owner.principal, "openai", access()),
          () => gamesService.createAi(owner.principal, aiMatch),
          () => gamesService.move(owner.principal, command(snapshot, "e2e4")),
          () => gamesService.lifecycle(owner.principal, control(snapshot, "abort")),
          () =>
            gamesService.controller(owner.principal, {
              gameId: snapshot.gameId,
              controllerId: snapshot.gameId,
              action: "heartbeat",
            }),
          () => gamesService.aiTurn(owner.principal, turnCommand(snapshot), access()),
        ]) {
          await expect(operation()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        }
        expect(await gamesService.snapshot(returning.principal, snapshot.gameId)).toEqual(snapshot);
        await api.database.db
          .update(aiControllers)
          .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(aiControllers.gameId, snapshot.gameId));
        await gamesService.expireControllers();
        expect(await gamesService.snapshot(returning.principal, snapshot.gameId)).toMatchObject({
          state: "paused",
          version: 1,
          moves: [],
        });
      } finally {
        gate.resolve(output("e2e4"));
        await pending;
      }
    },
  );

  it("prevents inference after session loss during discovery and drops a revoked standalone catalog", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    let revoked = false;
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [
        async () => {
          await createAuth(api.database, AUTH_ENVIRONMENT).api.signOut({
            headers: new Headers({ cookie: owner.cookie }),
          });
          revoked = true;
          return { ok: true, models: turnCatalog("openai") };
        },
      ],
      moves: [output("e2e4")],
    });
    const gamesService = createGameService(api.repository, {
      nodeEnv: "test",
      sandboxEnabled: true,
      aiAdapters: { openai: adapter },
    });
    const { snapshot } = await gamesService.createAi(owner.principal, aiMatch);
    await gamesService.controller(owner.principal, {
      gameId: snapshot.gameId,
      controllerId: snapshot.gameId,
      expectedVersion: 0,
      action: "acquire",
    });
    await expect(
      gamesService.aiTurn(owner.principal, turnCommand(snapshot), access()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(revoked).toBe(true);
    expect(adapter.moveCalls).toBe(0);
    expect(
      await api.repository.read((reader) => reader.getModelInvocations(snapshot.gameId)),
    ).toEqual([]);
    const other = await harness.account(api);
    const discoveryAdapter = createScriptedAdapter({
      provider: "openai",
      models: [
        async () => {
          await api.database.db
            .delete(authSchema.session)
            .where(eq(authSchema.session.id, other.principal.sessionId));
          return { ok: true, models: turnCatalog("openai") };
        },
      ],
    });
    const discoveryService = createGameService(api.repository, {
      nodeEnv: "test",
      sandboxEnabled: false,
      aiAdapters: { openai: discoveryAdapter },
    });
    await expect(
      discoveryService.models(other.principal, "openai", access()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("does not dispatch an automatic retry after session revocation between attempts", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    let invalidRecorded = false;
    let revoked = false;
    const repository: GameRepository = {
      ...api.repository,
      write: async (action) => {
        const result = await api.repository.write((tx) =>
          action({
            ...tx,
            async incrementAiInvalidCount(id) {
              const count = await tx.incrementAiInvalidCount(id);
              invalidRecorded = true;
              return count;
            },
          }),
        );
        if (invalidRecorded && !revoked) {
          revoked = true;
          await createAuth(api.database, AUTH_ENVIRONMENT).api.signOut({
            headers: new Headers({ cookie: owner.cookie }),
          });
        }
        return result;
      },
    };
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [
        {
          ok: false,
          error: { code: "model_invalid", reason: "malformed_output" },
          durationMs: 1,
          usage: null,
          providerRequestId: null,
        },
        output("e2e4"),
      ],
    });
    const { snapshot } = await service(api).createAi(owner.principal, aiMatch);
    await expect(
      service(api, { openai: adapter }, repository).aiTurn(
        owner.principal,
        turnCommand(snapshot),
        access(),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(adapter.moveCalls).toBe(1);
    expect(await api.repository.read((reader) => reader.getAiTurns(snapshot.gameId))).toMatchObject(
      [{ invalidOutputCount: 1, attemptCount: 1 }],
    );
  });

  it("pauses an orphaned account turn on API startup even when the dispatching session has been revoked", async () => {
    const first = await harness.createApi();
    const owner = await harness.account(first);
    const nextSession = await harness.anotherSession(first, owner);
    const { snapshot } = await service(first).createAi(owner.principal, aiMatch);
    const child = fork(
      fileURLToPath(new URL("./providers/orphaned-turn.ts", import.meta.url)),
      [],
      {
        execArgv: ["--conditions=development", "--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    try {
      const dispatched = once(child, "message");
      child.send({ command: turnCommand(snapshot), principal: owner.principal });
      expect((await dispatched)[0]).toBe("dispatched");
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await post(first, owner.cookie, "/api/auth/sign-out", {});
    await first.database.db
      .update(aiControllers)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(aiControllers.gameId, snapshot.gameId));
    await harness.close(first);
    const adapter = createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] });
    const restarted = await harness.createApi({ aiAdapters: { openai: withTurnCatalog(adapter) } });
    await restarted.app.ready();
    const recovered = await service(restarted).snapshot(nextSession.principal, snapshot.gameId);
    expect(recovered).toMatchObject({ state: "paused", version: 1, moves: [] });
    expect(
      await restarted.repository.read((reader) => reader.getModelInvocations(snapshot.gameId)),
    ).toMatchObject([{ outcome: "interrupted" }]);
    expect(
      await restarted.repository.write((tx) => tx.getAiTurnReservation(snapshot.gameId)),
    ).toBeUndefined();
    expect(adapter.moveCalls).toBe(0);
    expect((await get(restarted, nextSession.cookie, "/games/unfinished")).json()).toMatchObject({
      game: { snapshot: recovered },
    });
  });
});
