import {
  aiControllers,
  aiTurnReservations,
  gameCommands,
  type GameRepository,
  games,
  guestSessions,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";
import { createGuestService } from "../src/guests/service.js";

import {
  access,
  aiMatch,
  control,
  gatedAdapter,
  output,
  service,
  turnCommand,
} from "./ai-turn-helpers.js";
import { ApiHarness, command, createSandbox, WEB_ORIGIN } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

describe("server-derived identity boundary", () => {
  it("derives the principal from the guest cookie and rejects identity fields on every POST", async () => {
    const adapter = createScriptedAdapter({ provider: "openai", moves: [] });
    const api = await harness.createApi({ aiAdapters: { openai: adapter } });
    const owner = await harness.guest(api);
    const stranger = await harness.guest(api);
    const identity = await createGuestService(api.repository, 86_400).authenticate(owner.token);
    expect(identity.principal).toEqual({ kind: "guest", guestSessionId: owner.id });

    const gamesService = service(api);
    const sandbox = await createSandbox(api, owner);
    const { snapshot } = await gamesService.createAi(owner.principal, aiMatch);
    const requests = [
      { url: "/guest-session", payload: {} },
      { url: "/sandbox/games", payload: {} },
      { url: "/games", payload: aiMatch },
      { url: "/providers/models", payload: { provider: "openai", apiKey: "fixture-key" } },
      { url: `/games/${sandbox.gameId}/moves`, payload: command(sandbox, "e2e4") },
      { url: `/games/${sandbox.gameId}/lifecycle`, payload: control(sandbox, "abort") },
      {
        url: `/games/${snapshot.gameId}/controller`,
        payload: {
          gameId: snapshot.gameId,
          controllerId: snapshot.gameId,
          action: "heartbeat",
        },
      },
      {
        url: `/games/${snapshot.gameId}/ai-turn`,
        payload: { ...turnCommand(snapshot), apiKey: "fixture-key" },
      },
    ];
    const guestCount = await api.database.db.$count(guestSessions);
    for (const request of requests) {
      for (const forged of [
        { principal: identity.principal },
        { guestSessionId: owner.id },
        { userId: owner.id, kind: "account" },
      ]) {
        const response = await api.app.inject({
          method: "POST",
          url: request.url,
          payload: { ...request.payload, ...forged },
          headers: { origin: WEB_ORIGIN, cookie: stranger.cookie },
        });
        expect(response.statusCode, request.url).toBe(400);
        expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.body).not.toContain(owner.id);
      }
    }
    for (const [cookie, status] of [
      [stranger.cookie, 404],
      [undefined, 401],
    ] as const) {
      const response = await api.app.inject({
        method: "GET",
        url: `/games/${snapshot.gameId}`,
        headers: {
          ...(cookie ? { cookie } : {}),
          "x-guest-session-id": owner.id,
          "x-user-id": owner.id,
          authorization: `Bearer ${owner.id}`,
        },
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain(snapshot.fen);
    }
    expect(await api.database.db.$count(guestSessions)).toBe(guestCount);
    expect(await gamesService.snapshot(owner.principal, sandbox.gameId)).toEqual(sandbox);
    expect(await gamesService.snapshot(owner.principal, snapshot.gameId)).toEqual(snapshot);
    expect(adapter.moveCalls).toBe(0);
    expect(adapter.discoveryCalls).toBe(0);
  });

  it("rechecks expiry after an identity lock wait and rejects a stale principal across service entry points", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const sandbox = await createSandbox(api, owner);
    const other = await harness.createApi();
    const enteringLock = Promise.withResolvers<void>();
    const locks: string[] = [];
    const repository: GameRepository = {
      ...other.repository,
      write: (action) =>
        other.repository.write((tx) =>
          action({
            ...tx,
            async lockGuest(id) {
              locks.push("identity");
              enteringLock.resolve();
              return tx.lockGuest(id);
            },
            async lockGame(id) {
              locks.push("game");
              return tx.lockGame(id);
            },
          }),
        ),
    };
    const adapter = createScriptedAdapter({ provider: "openai", moves: [] });
    const gamesService = createGameService(repository, {
      nodeEnv: "test",
      sandboxEnabled: true,
      aiAdapters: { openai: adapter },
    });
    let outcome: Promise<{ error?: unknown }> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx.select().from(guestSessions).where(eq(guestSessions.id, owner.id)).for("update");
      const pending = gamesService.move(owner.principal, command(sandbox, "e2e4"));
      outcome = pending.then(
        () => ({}),
        (error: unknown) => ({ error }),
      );
      await enteringLock.promise;
      await tx
        .update(guestSessions)
        .set({
          lastSeenAt: sql`clock_timestamp() - interval '2 seconds'`,
          expiresAt: sql`clock_timestamp() - interval '1 second'`,
        })
        .where(eq(guestSessions.id, owner.id));
    });
    expect(await outcome).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(locks).toEqual(["identity"]);

    const staleOperations = [
      () => gamesService.details(owner.principal, sandbox.gameId),
      () => gamesService.snapshot(owner.principal, sandbox.gameId),
      () => gamesService.replay(owner.principal, sandbox.gameId),
      () => gamesService.pgn(owner.principal, sandbox.gameId),
      () => gamesService.invocations(owner.principal, sandbox.gameId),
      () => gamesService.unfinished(owner.principal),
      () => gamesService.unfinishedGame(owner.principal),
      () => gamesService.createSandbox(owner.principal),
      () => gamesService.createAi(owner.principal, aiMatch),
      () => gamesService.models(owner.principal, "openai", access()),
      () => gamesService.lifecycle(owner.principal, control(sandbox, "abort")),
      () => gamesService.aiTurn(owner.principal, turnCommand(sandbox), access()),
      () =>
        gamesService.controller(owner.principal, {
          gameId: sandbox.gameId,
          controllerId: sandbox.gameId,
          action: "heartbeat",
        }),
    ];
    for (const operation of staleOperations) {
      await expect(operation()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(await api.repository.read((reader) => reader.getGame(sandbox.gameId))).toMatchObject({
      state: "active",
      version: 0,
    });
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, sandbox.gameId)),
    ).toBe(0);
    expect(adapter.discoveryCalls).toBe(0);
    expect(adapter.moveCalls).toBe(0);
  });

  it("discards late inference and pauses expired presence even after guest access expires", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const gate = gatedAdapter();
    const gamesService = service(api, { openai: gate.adapter });
    const { snapshot } = await gamesService.createAi(owner.principal, aiMatch);
    const sandbox = await gamesService.createSandbox(owner.principal);
    const pending = gamesService.aiTurn(owner.principal, turnCommand(snapshot), access());
    const outcome = pending.then(
      () => ({}),
      (error: unknown) => ({ error }),
    );
    try {
      await gate.entered;
      await api.database.db
        .update(guestSessions)
        .set({
          lastSeenAt: sql`clock_timestamp() - interval '2 seconds'`,
          expiresAt: sql`clock_timestamp() - interval '1 second'`,
        })
        .where(eq(guestSessions.id, owner.id));
    } finally {
      gate.resolve(output("e2e4", "must not be accepted"));
      await outcome;
    }
    expect(await outcome).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    const attempts = await api.repository.read((reader) =>
      reader.getModelInvocations(snapshot.gameId),
    );
    expect(attempts).toMatchObject([{ outcome: "discarded", commentary: null }]);
    expect(
      await api.repository.write((tx) => tx.getAiTurnReservation(snapshot.gameId)),
    ).toMatchObject({ state: "blocked" });
    await api.database.db
      .update(aiControllers)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(aiControllers.gameId, snapshot.gameId));
    await gamesService.expireControllers();
    const stored = await api.repository.read((reader) => reader.getGame(snapshot.gameId));
    expect(stored).toMatchObject({
      state: "paused",
      version: 1,
      fen: snapshot.fen,
      pgn: snapshot.pgn,
    });
    expect(await api.repository.read((reader) => reader.getMoves(snapshot.gameId))).toEqual([]);
    expect(
      await api.database.db.$count(
        aiTurnReservations,
        eq(aiTurnReservations.gameId, snapshot.gameId),
      ),
    ).toBe(0);
    expect(
      await api.database.db.$count(aiControllers, eq(aiControllers.gameId, snapshot.gameId)),
    ).toBe(0);
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(2);
    expect(await api.repository.read((reader) => reader.getGame(sandbox.gameId))).toMatchObject({
      state: "active",
      version: 0,
    });
    expect(gate.adapter.moveCalls).toBe(1);
    await expect(gamesService.snapshot(owner.principal, snapshot.gameId)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
