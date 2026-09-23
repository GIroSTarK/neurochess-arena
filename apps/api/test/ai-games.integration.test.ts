import { randomUUID } from "node:crypto";

import {
  type AiGameConfiguration,
  type AiSeat,
  gameDetailsSchema,
  type GameSnapshot,
  unfinishedGameDetailsSchema,
} from "@neurochess/contracts";
import { gameParticipants, games, guestSessions } from "@neurochess/database";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { GameConflictError, GameIntegrityError } from "../src/games/errors.js";
import { createGameService } from "../src/games/service.js";

import { ApiHarness, command, createSandbox, play, type TestApi, WEB_ORIGIN } from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

const ai: AiSeat = {
  type: "ai",
  provider: "openrouter",
  modelId: "fixture/model:variant",
  parameters: {},
};
const aiMatch: AiGameConfiguration = {
  mode: "ai_vs_ai",
  seats: {
    white: { ...ai, parameters: { temperature: 0, maxOutputTokens: 500 } },
    black: { ...ai, parameters: { reasoningEffort: "high" } },
  },
};
function humanMatch(color: "white" | "black"): AiGameConfiguration {
  return {
    mode: "ai_vs_human",
    seats:
      color === "white"
        ? { white: { type: "human" }, black: ai }
        : { white: ai, black: { type: "human" } },
  };
}
function service(api: TestApi, sandboxEnabled = true) {
  return createGameService(api.repository, { nodeEnv: "test", sandboxEnabled });
}
function control(snapshot: GameSnapshot, action: "pause" | "resume" | "abort") {
  return {
    gameId: snapshot.gameId,
    expectedVersion: snapshot.version,
    commandId: randomUUID(),
    action,
  };
}

describe("ordinary AI configuration through the real game service", () => {
  it.each([
    { name: "AI versus AI", configuration: aiMatch },
    { name: "human White versus AI", configuration: humanMatch("white") },
    { name: "AI versus human Black", configuration: humanMatch("black") },
  ])(
    "persists and restores $name across independent instances privately",
    async ({ configuration }) => {
      const api = await harness.createApi({ sandboxEnabled: false });
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const first = service(api, false);
      const input = structuredClone(configuration);
      const created = await first.createAi(principal, input);
      expect(gameDetailsSchema.parse(created)).toEqual(created);
      expect(created).toMatchObject({
        configuration,
        snapshot: { state: "active", version: 0, moves: [], turn: "white" },
      });
      const stored = await api.repository.read((reader) => reader.getGame(created.snapshot.gameId));
      expect(stored).toMatchObject({
        mode: configuration.mode,
        isSandbox: false,
        ownerGuestSessionId: owner.id,
      });
      const seats = await api.repository.read((reader) =>
        reader.getParticipants(created.snapshot.gameId),
      );
      expect(seats).toHaveLength(2);
      for (const seat of seats) {
        const selected = configuration.seats[seat.color];
        expect(seat.seatType).toBe(selected.type);
        expect(seat.guestSessionId).toBe(selected.type === "human" ? owner.id : null);
        expect(seat.provider).toBe(selected.type === "ai" ? selected.provider : null);
        expect(seat.modelId).toBe(selected.type === "ai" ? selected.modelId : null);
        expect(seat.parameters).toEqual(selected.type === "ai" ? selected.parameters : null);
      }
      if (input.seats.white.type === "ai") input.seats.white.parameters.temperature = 9;
      await harness.close(api);
      const restarted = await harness.createApi({ sandboxEnabled: false });
      const restored = service(restarted, false);
      expect(await restored.details(principal, created.snapshot.gameId)).toEqual(created);
      expect(await restored.snapshot(principal, created.snapshot.gameId)).toEqual(created.snapshot);
      expect(unfinishedGameDetailsSchema.parse(await restored.unfinishedGame(principal))).toEqual({
        game: created,
      });
      const serialized = JSON.stringify(created);
      for (const forbidden of [owner.id, owner.token, "apiKey", "guestSessionId", "isSandbox"]) {
        expect(serialized).not.toContain(forbidden);
      }
    },
  );

  it("preserves full Sandbox history, null legacy configuration, existing discovery and its HTTP shape", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const initial = await createSandbox(api, owner);
    const played = await play(api, owner, initial, ["e2e4", "e7e5", "g1f3"]);
    const paused = await service(api).lifecycle(principal, control(played, "pause"));
    const restarted = await harness.createApi();
    const recovered = await service(restarted).details(principal, initial.gameId);
    expect(recovered).toEqual({ configuration: null, snapshot: paused });
    expect(await service(restarted).unfinished(principal)).toEqual({ snapshot: paused });
    expect(await service(restarted).unfinishedGame(principal)).toEqual({ game: null });
    expect(await service(restarted).lifecycle(principal, control(paused, "resume"))).toMatchObject({
      moves: played.moves,
      fen: played.fen,
    });
    await expect(
      service(restarted, false).details(principal, initial.gameId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["white", "black"] as const)(
    "assigns only the %s human seat and rejects moving or resigning the AI seat",
    async (humanColor) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const gamesService = service(api);
      const configuration = humanMatch(humanColor);
      let { snapshot } = await gamesService.createAi(principal, configuration);
      if (humanColor === "white") {
        snapshot = await gamesService.move(principal, command(snapshot, "e2e4"));
        expect(snapshot.moves).toHaveLength(1);
      }
      await expect(
        gamesService.move(principal, command(snapshot, humanColor === "white" ? "e7e5" : "e2e4")),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const paused = await gamesService.lifecycle(principal, control(snapshot, "pause"));
      await expect(
        gamesService.lifecycle(principal, {
          ...control(paused, "pause"),
          action: "resign",
          losingColor: humanColor === "white" ? "black" : "white",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const final = await gamesService.lifecycle(principal, {
        ...control(paused, "pause"),
        action: "resign",
        losingColor: humanColor,
      });
      expect(final).toMatchObject({
        state: "completed",
        terminationReason: "human_resignation",
        result: humanColor === "white" ? "0-1" : "1-0",
      });
      expect((await gamesService.details(principal, final.gameId)).configuration).toEqual(
        configuration,
      );
    },
  );

  it("never gives an AI-versus-AI owner human move or resignation authority", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const gamesService = service(api);
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    await expect(gamesService.move(principal, command(snapshot, "e2e4"))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    for (const losingColor of ["white", "black"] as const) {
      await expect(
        gamesService.lifecycle(principal, {
          ...control(snapshot, "pause"),
          action: "resign",
          losingColor,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(snapshot);
  });

  it("keeps configuration, snapshots, commands, replay and PGN private through completion and later creation", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const stranger = await harness.guest(api);
    const principal = owner.principal;
    const other = stranger.principal;
    const gamesService = service(api);
    const created = await gamesService.createAi(principal, aiMatch);
    const snapshot = await gamesService.lifecycle(principal, control(created.snapshot, "abort"));
    await gamesService.createAi(principal, humanMatch("white"));
    expect(await gamesService.details(principal, snapshot.gameId)).toEqual({
      snapshot,
      configuration: aiMatch,
    });
    expect((await gamesService.replay(principal, snapshot.gameId)).snapshot).toEqual(snapshot);
    expect((await gamesService.pgn(principal, snapshot.gameId)).pgn).toBe(snapshot.pgn);
    for (const operation of [
      () => gamesService.details(other, snapshot.gameId),
      () => gamesService.snapshot(other, snapshot.gameId),
      () => gamesService.replay(other, snapshot.gameId),
      () => gamesService.pgn(other, snapshot.gameId),
      () => gamesService.move(other, command(snapshot, "e2e4")),
      () => gamesService.lifecycle(other, control(snapshot, "abort")),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await gamesService.unfinishedGame(other)).toEqual({ game: null });
    await api.database.db
      .update(guestSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
        expiresAt: sql`clock_timestamp() - interval '1 hour'`,
      })
      .where(eq(guestSessions.id, owner.id));
    for (const operation of [
      () => gamesService.details(principal, snapshot.gameId),
      () => gamesService.unfinishedGame(principal),
      () => gamesService.createAi(principal, aiMatch),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("rejects untrusted configuration through service and HTTP without reserving a slot or persisting secrets", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const gamesService = service(api);
    for (const input of [
      { ...aiMatch, apiKey: "sentinel-key" },
      { ...aiMatch, isSandbox: true },
      {
        ...aiMatch,
        seats: { white: { ...ai, parameters: { apiKey: "sentinel-key" } }, black: ai },
      },
      {
        mode: "ai_vs_human",
        seats: { white: { type: "human", guestSessionId: owner.id }, black: ai },
      },
      { mode: "ai_vs_human", seats: { white: { type: "human" }, black: { type: "human" } } },
    ]) {
      const result = gamesService.createAi(principal, input);
      await expect(result).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: "INVALID_REQUEST",
      });
      const response = await api.app.inject({
        method: "POST",
        url: "/games",
        payload: input,
        headers: { cookie: owner.cookie, origin: WEB_ORIGIN },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("sentinel-key");
    }
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(0);
    expect((await gamesService.createAi(principal, aiMatch)).configuration).toEqual(aiMatch);
    expect(await gamesService.unfinished(principal)).toEqual({ snapshot: null });
  });

  it.each([
    { name: "AI versus AI", configuration: aiMatch },
    { name: "human White versus AI", configuration: humanMatch("white") },
    { name: "AI versus human Black", configuration: humanMatch("black") },
  ])("keeps paused $name independent from Sandbox commands", async ({ configuration }) => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const gamesService = service(api);
    const created = await gamesService.createAi(principal, configuration);
    const paused = await gamesService.lifecycle(principal, control(created.snapshot, "pause"));
    expect(await gamesService.unfinished(principal)).toEqual({ snapshot: null });

    const sandbox = await gamesService.createSandbox(principal);
    expect(sandbox.gameId).not.toBe(paused.gameId);
    expect(sandbox).toMatchObject({ state: "active", version: 0, moves: [] });
    const recovered = await gamesService.lifecycle(principal, control(sandbox, "pause"));
    const resumed = await gamesService.lifecycle(principal, control(recovered, "resume"));
    const played = await gamesService.move(principal, command(resumed, "e2e4"));
    expect(await gamesService.unfinished(principal)).toEqual({ snapshot: played });
    expect(await gamesService.unfinishedGame(principal)).toEqual({
      game: { snapshot: paused, configuration },
    });
    expect(await service(api, false).unfinishedGame(principal)).toEqual({
      game: { snapshot: paused, configuration },
    });
    await expect(service(api, false).createSandbox(principal)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(gamesService.createSandbox(principal)).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: played,
    });
    await expect(gamesService.createAi(principal, configuration)).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: paused,
    });

    await gamesService.lifecycle(principal, control(played, "abort"));
    const replacement = await gamesService.createSandbox(principal);
    expect(replacement.gameId).not.toBe(played.gameId);
    expect(await gamesService.snapshot(principal, paused.gameId)).toEqual(paused);
    await gamesService.lifecycle(principal, control(paused, "abort"));
    expect(await gamesService.unfinishedGame(principal)).toEqual({ game: null });
    expect(await gamesService.unfinished(principal)).toEqual({ snapshot: replacement });
    expect((await gamesService.createAi(principal, configuration)).snapshot.gameId).not.toBe(
      paused.gameId,
    );
  });

  it("serializes concurrent creation within each of the ordinary and Sandbox slots", async () => {
    const apis = await Promise.all([
      harness.createApi(),
      harness.createApi(),
      harness.createApi(),
      harness.createApi(),
    ]);
    const owner = await harness.guest(apis[0]);
    const principal = owner.principal;
    const results = await Promise.allSettled([
      service(apis[0])
        .createAi(principal, aiMatch)
        .then((game) => game.snapshot),
      service(apis[1])
        .createAi(principal, humanMatch("black"))
        .then((game) => game.snapshot),
      service(apis[2]).createSandbox(principal),
      service(apis[3]).createSandbox(principal),
    ]);
    const gamesService = service(apis[0]);
    for (const group of [results.slice(0, 2), results.slice(2)]) {
      const winners = group.filter((result) => result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const result of group) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(GameConflictError);
          expect((result.reason as GameConflictError).currentSnapshot).toEqual(winners[0]!.value);
        }
      }
    }
    expect(await apis[0].database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(
      2,
    );
    const ordinary = (await gamesService.unfinishedGame(principal)).game!.snapshot;
    const sandbox = (await gamesService.unfinished(principal)).snapshot!;
    const paused = await gamesService.lifecycle(principal, control(ordinary, "pause"));
    const pausedSandbox = await gamesService.lifecycle(principal, control(sandbox, "pause"));
    for (const create of [
      () => gamesService.createAi(principal, aiMatch),
      () => gamesService.createAi(principal, humanMatch("white")),
    ]) {
      await expect(create()).rejects.toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: paused,
      });
    }
    await expect(gamesService.createSandbox(principal)).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: pausedSandbox,
    });
    const aborted = await gamesService.lifecycle(principal, control(paused, "abort"));
    expect((await gamesService.createAi(principal, aiMatch)).snapshot.gameId).not.toBe(
      aborted.gameId,
    );
    expect((await gamesService.details(principal, aborted.gameId)).snapshot).toEqual(aborted);
  });

  it("rolls back the entire AI creation after an actual participant insert fails", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const failing = createGameService(
      {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              async insertGame(game, participants) {
                await tx.insertGame(game, participants);
                throw new Error("Injected failure after insertion");
              },
            }),
          ),
      },
      { nodeEnv: "test", sandboxEnabled: true },
    );
    await expect(failing.createAi(owner.principal, aiMatch)).rejects.toThrow(
      "Injected failure after insertion",
    );
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, owner.id))).toBe(0);
    expect((await service(api).createAi(owner.principal, aiMatch)).snapshot.version).toBe(0);
  });

  it("rejects corrupt mode/seat combinations and reassigned humans before returning configuration or accepting commands", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const stranger = await harness.guest(api);
    const principal = owner.principal;
    const gamesService = service(api);
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    await api.database.db
      .update(games)
      .set({ mode: "ai_vs_human" })
      .where(eq(games.id, snapshot.gameId));
    for (const read of [
      () => gamesService.details(principal, snapshot.gameId),
      () => gamesService.snapshot(principal, snapshot.gameId),
      () => gamesService.unfinishedGame(principal),
      () => gamesService.lifecycle(principal, control(snapshot, "pause")),
    ]) {
      await expect(read()).rejects.toBeInstanceOf(GameIntegrityError);
    }
    await api.database.db
      .update(gameParticipants)
      .set({
        seatType: "human",
        provider: null,
        modelId: null,
        parameters: null,
        guestSessionId: stranger.id,
      })
      .where(
        and(eq(gameParticipants.gameId, snapshot.gameId), eq(gameParticipants.color, "white")),
      );
    await expect(gamesService.details(principal, snapshot.gameId)).rejects.toBeInstanceOf(
      GameIntegrityError,
    );
    await expect(gamesService.details(stranger.principal, snapshot.gameId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
