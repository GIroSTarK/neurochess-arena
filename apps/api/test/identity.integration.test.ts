import { randomUUID } from "node:crypto";

import { aiControllers, gameCommands, games, guestSessions } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";
import { createGuestService } from "../src/guests/service.js";

import { aiMatch, control, service, turnCommand } from "./ai-turn-helpers.js";
import { ApiHarness, WEB_ORIGIN } from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

describe("server-derived game identity", () => {
  it("projects a guest principal from the authenticated cookie without carrying its token", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const guests = createGuestService(api.repository, 86_400);
    const { principal } = await guests.authenticate(owner.token);
    expect(principal).toEqual({ kind: "guest", guestSessionId: owner.id });
    const { snapshot } = await service(api).createAi(principal, aiMatch);
    expect(await service(api).snapshot(principal, snapshot.gameId)).toEqual(snapshot);
    await expect(guests.authenticate(owner.id)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an unsupported principal kind even when it carries a valid guest ID", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const gamesService = service(api);
    const principal = { kind: "guest" as const, guestSessionId: owner.id };
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    const unsupported = { ...principal, kind: "account" } as unknown as typeof principal;
    await expect(gamesService.snapshot(unsupported, snapshot.gameId)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      gamesService.lifecycle(unsupported, control(snapshot, "pause")),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(snapshot);
  });

  it("does not accept request-body identity on bootstrap, creation, discovery or game commands", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const stranger = await harness.guest(api);
    const { snapshot } = await service(api).createAi(
      { kind: "guest", guestSessionId: owner.id },
      aiMatch,
    );
    const command = turnCommand(snapshot);
    const requests = [
      { url: "/guest-session", payload: {} },
      { url: "/sandbox/games", payload: {} },
      { url: "/games", payload: aiMatch },
      { url: "/providers/models", payload: { provider: "openai", apiKey: "fixture-key" } },
      {
        url: `/games/${snapshot.gameId}/moves`,
        payload: { ...command, move: "e2e4", controllerId: undefined },
      },
      { url: `/games/${snapshot.gameId}/lifecycle`, payload: control(snapshot, "pause") },
      { url: `/games/${snapshot.gameId}/ai-turn`, payload: { ...command, apiKey: "fixture-key" } },
      {
        url: `/games/${snapshot.gameId}/controller`,
        payload: { gameId: snapshot.gameId, controllerId: randomUUID(), action: "heartbeat" },
      },
    ];
    for (const extra of [
      { principal: { kind: "guest", guestSessionId: owner.id } },
      { guestSessionId: owner.id },
      { userId: owner.id },
    ]) {
      for (const request of requests) {
        const response = await api.app.inject({
          method: "POST",
          url: request.url,
          payload: { ...request.payload, ...extra },
          headers: { origin: WEB_ORIGIN, cookie: stranger.cookie },
        });
        expect(response.statusCode, request.url).toBe(400);
        expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
        expect(response.json()).not.toHaveProperty("currentSnapshot");
      }
    }
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: `/games/${snapshot.gameId}`,
          headers: { cookie: stranger.cookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("rechecks guest validity after waiting for the identity lock before creating a game", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const locking = Promise.withResolvers<void>();
    const gamesService = createGameService(
      {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              lockGuest: (id) => {
                locking.resolve();
                return tx.lockGuest(id);
              },
            }),
          ),
      },
      { nodeEnv: "test", sandboxEnabled: true },
    );
    let outcome: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx.select().from(guestSessions).where(eq(guestSessions.id, owner.id)).for("update");
      outcome = gamesService.createSandbox({ kind: "guest", guestSessionId: owner.id }).then(
        (snapshot) => ({ snapshot }),
        (error: unknown) => ({ error }),
      );
      await locking.promise;
      await tx
        .update(guestSessions)
        .set({
          lastSeenAt: sql`clock_timestamp() - interval '2 seconds'`,
          expiresAt: sql`clock_timestamp() - interval '1 second'`,
        })
        .where(eq(guestSessions.id, owner.id));
    });
    expect(await outcome).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(0);
  });

  it("still pauses an abandoned game after the guest session expires without renewing it", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = { kind: "guest" as const, guestSessionId: owner.id };
    const gamesService = service(api);
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    await api.database.db
      .update(guestSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '2 seconds'`,
        expiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(guestSessions.id, owner.id));
    await api.database.db
      .update(aiControllers)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(aiControllers.gameId, snapshot.gameId));
    await gamesService.expireControllers();
    const [stored] = await api.database.db
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
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
    ).toBe(1);
    expect(
      await api.database.db.$count(aiControllers, eq(aiControllers.gameId, snapshot.gameId)),
    ).toBe(0);
    await expect(gamesService.snapshot(principal, snapshot.gameId)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      createGuestService(api.repository, 86_400).authenticate(owner.token),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
