import { randomUUID } from "node:crypto";

import { aiControllers, aiTurnReservations, gameCommands, games } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";

import {
  access,
  aiMatch,
  control,
  gatedAdapter,
  output,
  service,
  turnCommand,
} from "./ai-turn-helpers.js";
import { ApiHarness, createSandbox, FOOLS_MATE } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

describe("database-backed AI controllers and paused single steps", () => {
  it("requires a live claim before inference or resume and keeps controller operations private", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const stranger = await harness.guest(api);
    const principal = { guestSessionId: owner.id };
    const adapter = createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] });
    const gamesService = createGameService(api.repository, {
      nodeEnv: "test",
      sandboxEnabled: true,
      aiAdapters: { openai: adapter },
    });
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    const claim = {
      gameId: snapshot.gameId,
      expectedVersion: 0,
      controllerId: randomUUID(),
      action: "acquire",
    };
    await expect(
      gamesService.aiTurn(
        principal,
        { ...turnCommand(snapshot), controllerId: claim.controllerId },
        access(),
      ),
    ).rejects.toMatchObject({ code: "AI_CONTROLLER_LOST" });
    await expect(
      gamesService.controller({ guestSessionId: stranger.id }, claim),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await gamesService.controller(principal, claim)).toEqual(snapshot);
    await expect(
      gamesService.controller(principal, { ...claim, controllerId: randomUUID() }),
    ).rejects.toMatchObject({ code: "AI_CONTROLLER_BUSY" });
    const paused = await gamesService.lifecycle(principal, {
      gameId: snapshot.gameId,
      expectedVersion: 0,
      commandId: randomUUID(),
      action: "pause",
    });
    await expect(
      gamesService.lifecycle(principal, {
        ...control(paused, "resume"),
        controllerId: claim.controllerId,
      }),
    ).rejects.toMatchObject({ code: "AI_CONTROLLER_LOST" });
    expect(adapter.moveCalls).toBe(0);
    expect(
      await api.database.db.$count(
        aiTurnReservations,
        eq(aiTurnReservations.gameId, snapshot.gameId),
      ),
    ).toBe(0);
  });

  it.each([false, true])(
    "pauses absent controllers between calls after restart (unclaimed: %s); reads never pause",
    async (unclaimed) => {
      const first = await harness.createApi();
      const owner = await harness.guest(first);
      const principal = { guestSessionId: owner.id };
      const original = unclaimed
        ? createGameService(first.repository, { nodeEnv: "test", sandboxEnabled: true })
        : service(first);
      const { snapshot } = await original.createAi(principal, aiMatch);
      const restarted = await harness.createApi();
      const restored = service(restarted);
      await first.database.db
        .update(aiControllers)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(aiControllers.gameId, snapshot.gameId));
      expect(await restored.snapshot(principal, snapshot.gameId)).toEqual(snapshot);
      expect((await restored.unfinishedGame(principal)).game?.snapshot).toEqual(snapshot);
      await expect(
        restored.controller(principal, {
          gameId: snapshot.gameId,
          controllerId: snapshot.gameId,
          action: "heartbeat",
        }),
      ).rejects.toMatchObject({ code: "AI_CONTROLLER_LOST" });
      await Promise.all([original.expireControllers(), restored.expireControllers()]);
      expect(await restored.snapshot(principal, snapshot.gameId)).toMatchObject({
        state: "paused",
        version: 1,
        moves: [],
        legalMoves: [],
      });
      expect(
        await first.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
      ).toBe(1);
      expect(
        await first.database.db.$count(aiControllers, eq(aiControllers.gameId, snapshot.gameId)),
      ).toBe(0);
    },
  );

  it("recovers pre-migration active AI records with no lease without affecting Sandbox", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const sandboxOwner = await harness.guest(api);
    const sandbox = await createSandbox(api, sandboxOwner);
    const principal = { guestSessionId: owner.id };
    const gamesService = service(api);
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    await api.database.db.delete(aiControllers).where(eq(aiControllers.gameId, snapshot.gameId));
    await gamesService.expireControllers();
    expect(await gamesService.snapshot(principal, snapshot.gameId)).toMatchObject({
      state: "paused",
      version: 1,
    });
    expect(
      await gamesService.snapshot({ guestSessionId: sandboxOwner.id }, sandbox.gameId),
    ).toEqual(sandbox);
  });

  it.each([false, true])(
    "fences an expired in-flight result before the sweeper runs (step: %s)",
    async (step) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const gate = gatedAdapter();
      const first = service(api, { openai: gate.adapter });
      let { snapshot } = await first.createAi(principal, aiMatch);
      if (step) snapshot = await first.lifecycle(principal, control(snapshot, "pause"));
      const pending = first.aiTurn(principal, { ...turnCommand(snapshot), step }, access());
      const rejected = expect(pending).rejects.toMatchObject({ code: "AI_CONTROLLER_LOST" });
      await gate.entered;
      await api.database.db
        .update(aiControllers)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(aiControllers.gameId, snapshot.gameId));
      gate.resolve(output("e2e4"));
      await rejected;
      await service(await harness.createApi()).expireControllers();
      expect(await first.snapshot(principal, snapshot.gameId)).toMatchObject({
        state: "paused",
        version: snapshot.version + 1,
        moves: [],
        legalMoves: [],
      });
      expect((await first.invocations(principal, snapshot.gameId)).turns[0]).toMatchObject({
        invalidOutputCount: 0,
        attempts: [{ outcome: "discarded" }],
      });
      expect(gate.adapter.moveCalls).toBe(1);
    },
  );

  it("renews presence independently of thinking and fences a competing tab through explicit paused recovery", async () => {
    const api = await harness.createApi();
    const other = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = { guestSessionId: owner.id };
    const gate = gatedAdapter();
    const first = service(api, { openai: gate.adapter });
    const second = service(other);
    const { snapshot } = await first.createAi(principal, aiMatch);
    const pending = first.aiTurn(principal, turnCommand(snapshot), access());
    const rejected = expect(pending).rejects.toMatchObject({ code: "GAME_CONFLICT" });
    await gate.entered;
    expect(
      await second.controller(principal, {
        gameId: snapshot.gameId,
        controllerId: snapshot.gameId,
        action: "heartbeat",
      }),
    ).toEqual(snapshot);
    const recovered = await second.lifecycle(principal, {
      gameId: snapshot.gameId,
      expectedVersion: 0,
      commandId: randomUUID(),
      action: "pause",
    });
    const nextId = randomUUID();
    await second.controller(principal, {
      gameId: snapshot.gameId,
      expectedVersion: recovered.version,
      controllerId: nextId,
      action: "acquire",
    });
    await expect(
      first.controller(principal, {
        gameId: snapshot.gameId,
        controllerId: snapshot.gameId,
        action: "heartbeat",
      }),
    ).rejects.toMatchObject({ code: "AI_CONTROLLER_LOST" });
    gate.resolve(output("e2e4"));
    await rejected;
    expect(await first.snapshot(principal, snapshot.gameId)).toEqual(recovered);
    expect(
      (
        await api.database.db
          .select()
          .from(aiControllers)
          .where(eq(aiControllers.gameId, snapshot.gameId))
      )[0]?.controllerId,
    ).toBe(nextId);
  });

  it("steps a complete match one revision at a time, never exposing playable paused snapshots", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = { guestSessionId: owner.id };
    const gamesService = service(api, {
      openai: createScriptedAdapter({
        provider: "openai",
        moves: [output(FOOLS_MATE[0]!), output(FOOLS_MATE[2]!)],
      }),
      anthropic: createScriptedAdapter({
        provider: "anthropic",
        moves: [output(FOOLS_MATE[1]!), output(FOOLS_MATE[3]!)],
      }),
    });
    let { snapshot } = await gamesService.createAi(principal, aiMatch);
    snapshot = await gamesService.lifecycle(principal, control(snapshot, "pause"));
    for (let index = 0; index < 4; index++) {
      const command = { ...turnCommand(snapshot), step: true };
      const previous = snapshot;
      snapshot = await gamesService.aiTurn(principal, command, access());
      expect(snapshot).toMatchObject({
        state: index === 3 ? "completed" : "paused",
        version: previous.version + 1,
        legalMoves: [],
      });
      expect(snapshot.moves).toHaveLength(index + 1);
      await expect(gamesService.aiTurn(principal, command, access())).rejects.toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: snapshot,
      });
    }
    expect(snapshot.terminationReason).toBe("checkmate");
    expect((await gamesService.replay(principal, snapshot.gameId)).snapshot).toEqual(snapshot);
  });

  it.each(["pause", "abort"] as const)(
    "keeps %s available during a paused step and discards a late result",
    async (action) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const gate = gatedAdapter();
      const gamesService = service(api, { openai: gate.adapter });
      const initial = (await gamesService.createAi(principal, aiMatch)).snapshot;
      const paused = await gamesService.lifecycle(principal, control(initial, "pause"));
      const command = { ...turnCommand(paused), step: true };
      const pending = gamesService.aiTurn(principal, command, access());
      const rejected = expect(pending).rejects.toMatchObject({ code: "GAME_CONFLICT" });
      await gate.entered;
      expect(await gamesService.snapshot(principal, paused.gameId)).toEqual(paused);
      await expect(gamesService.aiTurn(principal, command, access())).rejects.toMatchObject({
        code: "AI_TURN_IN_PROGRESS",
      });
      const final = await gamesService.lifecycle(principal, control(paused, action));
      gate.resolve(output("e2e4"));
      await rejected;
      expect(await gamesService.snapshot(principal, paused.gameId)).toEqual(final);
      expect(final.moves).toEqual([]);
      expect(await api.database.db.$count(games, eq(games.id, paused.gameId))).toBe(1);
    },
  );
});
