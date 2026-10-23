import { randomUUID } from "node:crypto";

import type { AiProvider, GameSnapshot, NormalizedMoveResponse } from "@neurochess/contracts";
import {
  aiTurnReservations,
  gameCommands,
  gameParticipants,
  games,
  guestSessions,
  moves,
} from "@neurochess/database";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { AI_MOVE_INSTRUCTIONS } from "../src/providers/adapter.js";

import {
  access,
  aiMatch,
  blackAi,
  control,
  createControlledAiGame,
  createTestGameService,
  gatedAdapter,
  humanMatch,
  output,
  turnCommand,
} from "./ai-turn-helpers.js";
import {
  ApiHarness,
  command,
  createSandbox,
  FOOLS_MATE,
  KNIGHT_CYCLE,
  WEB_ORIGIN,
} from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { turnCatalog } from "./providers/turn-catalog.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

describe("authoritative AI turns through injected adapters", () => {
  it("suppresses concurrent same-ID and different-ID dispatches across independent APIs without holding inference locks", async () => {
    const api = await harness.createApi();
    const otherApi = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const gate = gatedAdapter();
    const otherAdapter = createScriptedAdapter({ provider: "openai", moves: [output("d2d4")] });
    const first = createTestGameService(api, { openai: gate.adapter });
    const second = createTestGameService(otherApi, { openai: otherAdapter });
    const {
      details: { snapshot },
      controllerId,
    } = await createControlledAiGame(first, principal, aiMatch, randomUUID());
    const cmd = turnCommand(snapshot, controllerId);
    const pending = first.aiTurn(principal, cmd, access());
    await gate.entered;
    expect(await second.snapshot(principal, snapshot.gameId)).toEqual(snapshot);
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
    ).toBe(0);
    const attempts = await Promise.allSettled([
      second.aiTurn(principal, cmd, access()),
      second.aiTurn(principal, { ...cmd, commandId: cmd.commandId.toUpperCase() }, access()),
      second.aiTurn(principal, turnCommand(snapshot, controllerId), access()),
    ]);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({
        status: "rejected",
        reason: { code: "AI_TURN_IN_PROGRESS" },
      });
    }
    expect(otherAdapter.moveCalls).toBe(0);
    gate.resolve(output("e2e4"));
    const accepted = await pending;
    expect(accepted).toMatchObject({ version: 1, moves: [{ uci: "e2e4" }] });
    expect(gate.adapter.moveCalls).toBe(1);
    expect(await api.database.db.$count(moves, eq(moves.gameId, snapshot.gameId))).toBe(1);
    expect(
      await api.database.db.$count(
        aiTurnReservations,
        eq(aiTurnReservations.gameId, snapshot.gameId),
      ),
    ).toBe(0);
    await expect(second.aiTurn(principal, cmd, access())).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: accepted,
    });
    await expect(
      second.aiTurn(principal, { ...cmd, expectedVersion: accepted.version }, access()),
    ).rejects.toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: accepted });
    expect(otherAdapter.moveCalls).toBe(0);
  });

  it("builds both seats' inputs from complete history and reaches checkmate through the real service", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const snapshots: GameSnapshot[] = [];
    let ply = 0;
    function adapter(provider: AiProvider) {
      return createScriptedAdapter({
        provider,
        moves: [0, 1].map(() => (input) => {
          const before = snapshots.at(-1)!;
          const selected = before.turn === "white" ? aiMatch.seats.white : aiMatch.seats.black;
          expect(input).toEqual({
            ...access(input.signal),
            instructions: AI_MOVE_INSTRUCTIONS,
            modelId: selected.modelId,
            parameters: selected.parameters,
            capabilities: turnCatalog(provider).find(({ id }) => id === selected.modelId)!
              .capabilities,
            context: {
              fen: before.fen,
              pgn: before.pgn,
              turn: before.turn,
              color: before.turn,
              legalMoves: before.legalMoves,
            },
          });
          expect(input.context.pgn).not.toContain("viewer-only-sentinel");
          expect(input.context.pgn).not.toContain(owner.id);
          expect(input.context.pgn).not.toContain("fixture-");
          return output(FOOLS_MATE[ply++]!, "viewer-only-sentinel");
        }),
      });
    }
    const white = adapter("openai");
    const black = adapter("anthropic");
    const gamesService = createTestGameService(api, { openai: white, anthropic: black });
    const { details, controllerId } = await createControlledAiGame(
      gamesService,
      principal,
      aiMatch,
      randomUUID(),
    );
    snapshots.push(details.snapshot);
    for (let index = 0; index < 4; index++) {
      snapshots.push(
        await gamesService.aiTurn(
          principal,
          turnCommand(snapshots.at(-1)!, controllerId),
          access(),
        ),
      );
    }
    const final = snapshots.at(-1)!;
    expect(final).toMatchObject({
      version: 4,
      state: "completed",
      result: "0-1",
      terminationReason: "checkmate",
    });
    expect(final.moves.map((move) => move.uci)).toEqual(FOOLS_MATE);
    expect(final.pgn).toContain("1. f3 e5 2. g4 Qh4# 0-1");
    expect((await gamesService.replay(principal, final.gameId)).snapshot).toEqual(final);
    expect((await gamesService.pgn(principal, final.gameId)).pgn).toBe(final.pgn);
    expect(await gamesService.unfinishedGame(principal)).toEqual({ game: null });
    await expect(
      gamesService.aiTurn(principal, turnCommand(final, controllerId), access()),
    ).rejects.toMatchObject({ code: "INVALID_GAME_STATE" });
    expect([white.moveCalls, black.moveCalls]).toEqual([2, 2]);
    expect((await gamesService.createSandbox(principal)).gameId).not.toBe(final.gameId);
  });

  it("reconstructs repetition history across instance restart and pause/resume before accepting the drawing AI move", async () => {
    let api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const history = [...KNIGHT_CYCLE, ...KNIGHT_CYCLE];
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: history.slice(0, 7).map((move) => output(move)),
    });
    let gamesService = createTestGameService(api, { openai: adapter });
    const { details, controllerId } = await createControlledAiGame(
      gamesService,
      principal,
      {
        ...aiMatch,
        seats: { white: aiMatch.seats.white, black: aiMatch.seats.white },
      },
      randomUUID(),
    );
    let { snapshot } = details;
    for (let index = 0; index < 7; index++) {
      snapshot = await gamesService.aiTurn(
        principal,
        turnCommand(snapshot, controllerId),
        access(),
      );
    }
    await harness.close(api);
    api = await harness.createApi();
    const finalAdapter = createScriptedAdapter({
      provider: "openai",
      moves: [output(history[7]!)],
    });
    gamesService = createTestGameService(api, { openai: finalAdapter });
    expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(snapshot);
    snapshot = await gamesService.lifecycle(principal, control(snapshot, "pause", controllerId));
    snapshot = await gamesService.lifecycle(principal, control(snapshot, "resume", controllerId));
    snapshot = await gamesService.aiTurn(principal, turnCommand(snapshot, controllerId), access());
    expect(snapshot).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "threefold_repetition",
      version: 10,
    });
    expect(snapshot.moves.map((move) => move.uci)).toEqual(history);
    expect(snapshot.pgn).toContain("1/2-1/2");
  });

  it("rejects untrusted context, stale revisions, strangers, missing/expired guests and missing adapters before dispatch", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const stranger = await harness.guest(api);
    const principal = owner.principal;
    const adapter = createScriptedAdapter({ provider: "openai", moves: [] });
    const gamesService = createTestGameService(api, { openai: adapter });
    const {
      details: { snapshot },
      controllerId,
    } = await createControlledAiGame(gamesService, principal, aiMatch, randomUUID());
    const cmd = turnCommand(snapshot, controllerId);
    for (const extra of [
      { context: {} },
      { fen: snapshot.fen },
      { pgn: snapshot.pgn },
      { legalMoves: ["e2e4"] },
      { instructions: "sentinel-prompt" },
      { opponent: blackAi },
      { color: "black" },
      { move: "e2e4" },
      { apiKey: "sentinel" },
    ]) {
      await expect(
        gamesService.aiTurn(principal, { ...cmd, ...extra }, access()),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "INVALID_REQUEST" });
    }
    await expect(gamesService.aiTurn(stranger.principal, cmd, access())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      gamesService.aiTurn({ kind: "guest", guestSessionId: randomUUID() }, cmd, access()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      gamesService.aiTurn(principal, { ...cmd, expectedVersion: 1 }, access()),
    ).rejects.toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: snapshot });
    await expect(createTestGameService(api).aiTurn(principal, cmd, access())).rejects.toMatchObject(
      {
        code: "AI_ADAPTER_UNAVAILABLE",
      },
    );
    await expect(
      createTestGameService(api, { openai: { ...adapter, provider: "google" } }).aiTurn(
        principal,
        cmd,
        access(),
      ),
    ).rejects.toMatchObject({ code: "AI_ADAPTER_UNAVAILABLE" });
    const paused = await gamesService.lifecycle(
      principal,
      control(snapshot, "pause", controllerId),
    );
    await expect(
      gamesService.aiTurn(principal, turnCommand(paused, controllerId), access()),
    ).rejects.toMatchObject({ code: "INVALID_GAME_STATE" });
    await api.database.db
      .update(guestSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
        expiresAt: sql`clock_timestamp() - interval '1 hour'`,
      })
      .where(eq(guestSessions.id, owner.id));
    await expect(
      gamesService.aiTurn(principal, turnCommand(paused, controllerId), access()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(adapter.moveCalls).toBe(0);
    expect(
      await api.database.db.$count(
        aiTurnReservations,
        eq(aiTurnReservations.gameId, snapshot.gameId),
      ),
    ).toBe(0);
    for (const url of [`/games/${snapshot.gameId}/ai-turn`, `/ai/games/${snapshot.gameId}/turn`]) {
      expect(
        (
          await api.app.inject({
            method: "POST",
            url,
            payload: { ...cmd, apiKey: "http-fixture-only" },
            headers: { origin: WEB_ORIGIN, cookie: stranger.cookie },
          })
        ).statusCode,
      ).toBe(404);
    }
  });

  it("rejects Sandbox and ordinary human turns while preserving human/AI receipt identity across kinds", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const adapter = createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] });
    const gamesService = createTestGameService(api, { openai: adapter });
    const sandbox = await createSandbox(api, owner);
    await expect(
      gamesService.aiTurn(principal, turnCommand(sandbox, sandbox.gameId), access()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await gamesService.lifecycle(principal, control(sandbox, "abort", sandbox.gameId));
    const { details, controllerId } = await createControlledAiGame(
      gamesService,
      principal,
      humanMatch,
      randomUUID(),
    );
    let { snapshot } = details;
    const aiCommand = turnCommand(snapshot, controllerId);
    snapshot = await gamesService.aiTurn(principal, aiCommand, access());
    await expect(
      gamesService.aiTurn(principal, turnCommand(snapshot, controllerId), access()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const operation of [
      () =>
        gamesService.move(principal, {
          ...command(snapshot, "e7e5"),
          commandId: aiCommand.commandId,
        }),
      () =>
        gamesService.lifecycle(principal, {
          ...control(snapshot, "pause", controllerId),
          commandId: aiCommand.commandId,
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: snapshot,
      });
    }
    const humanCommand = command(snapshot, "e7e5");
    snapshot = await gamesService.move(principal, humanCommand);
    await expect(
      gamesService.aiTurn(
        principal,
        { ...turnCommand(snapshot, controllerId), commandId: humanCommand.commandId },
        access(),
      ),
    ).rejects.toMatchObject({ code: "GAME_CONFLICT" });
    const pauseCommand = control(snapshot, "pause", controllerId);
    snapshot = await gamesService.lifecycle(principal, pauseCommand);
    snapshot = await gamesService.lifecycle(principal, control(snapshot, "resume", controllerId));
    await expect(
      gamesService.aiTurn(
        principal,
        { ...turnCommand(snapshot, controllerId), commandId: pauseCommand.commandId },
        access(),
      ),
    ).rejects.toMatchObject({ code: "GAME_CONFLICT" });
    expect(adapter.moveCalls).toBe(1);
  });

  it.each(["expiry", "owner", "seat", "model", "parameters"] as const)(
    "rechecks %s authority after inference before committing",
    async (changed) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const stranger = await harness.guest(api);
      const principal = owner.principal;
      const gate = gatedAdapter();
      const gamesService = createTestGameService(api, { openai: gate.adapter });
      const {
        details: { snapshot },
        controllerId,
      } = await createControlledAiGame(gamesService, principal, aiMatch, randomUUID());
      const pending = gamesService.aiTurn(principal, turnCommand(snapshot, controllerId), access());
      await gate.entered;
      if (changed === "expiry") {
        await api.database.db
          .update(guestSessions)
          .set({
            lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
            expiresAt: sql`clock_timestamp() - interval '1 hour'`,
          })
          .where(eq(guestSessions.id, owner.id));
      } else if (changed === "owner") {
        await api.database.db
          .update(games)
          .set({ ownerGuestSessionId: stranger.id })
          .where(eq(games.id, snapshot.gameId));
      } else {
        await api.database.db
          .update(gameParticipants)
          .set(
            changed === "seat"
              ? { id: randomUUID() }
              : changed === "model"
                ? { modelId: "changed-model" }
                : { parameters: { temperature: 1 } },
          )
          .where(
            and(eq(gameParticipants.gameId, snapshot.gameId), eq(gameParticipants.color, "white")),
          );
      }
      const expected =
        changed === "expiry" ? "UNAUTHORIZED" : changed === "owner" ? "NOT_FOUND" : "GAME_CONFLICT";
      const rejected = expect(pending).rejects.toMatchObject({ code: expected });
      gate.resolve(output("e2e4"));
      await rejected;
      expect(await api.database.db.$count(moves, eq(moves.gameId, snapshot.gameId))).toBe(0);
      expect(
        await api.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
      ).toBe(0);
      expect(
        await api.database.db
          .select()
          .from(aiTurnReservations)
          .where(eq(aiTurnReservations.gameId, snapshot.gameId)),
      ).toMatchObject([{ state: "blocked" }]);
    },
  );

  it.each([
    { name: "illegal move", response: output("e2e5") },
    { name: "missing move", response: { ...output("e2e4"), output: { commentary: "sentinel" } } },
    { name: "non-UCI move", response: { ...output("e2e4"), output: { move: "e4" } } },
    { name: "extra fields", response: { ...output("e2e4"), apiKey: "sentinel" } },
  ])(
    "never commits $name from the adapter, applies the failure policy and drops raw data",
    async ({ name, response }) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const adapter = {
        ...createScriptedAdapter({ provider: "openai" }),
        requestMove: async () => response as NormalizedMoveResponse,
      };
      const gamesService = createTestGameService(api, { openai: adapter });
      const {
        details: { snapshot },
        controllerId,
      } = await createControlledAiGame(gamesService, principal, aiMatch, randomUUID());
      const cmd = turnCommand(snapshot, controllerId);
      const accepted = await gamesService.aiTurn(principal, cmd, access());
      expect(accepted).toMatchObject({
        version: 1,
        moves: [],
        state: name === "extra fields" ? "paused" : "completed",
      });
      expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(accepted);
      await expect(gamesService.aiTurn(principal, cmd, access())).rejects.toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: accepted,
      });
      expect(
        await api.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
      ).toBe(1);
      const rows = await api.database.db
        .select()
        .from(aiTurnReservations)
        .where(eq(aiTurnReservations.gameId, snapshot.gameId));
      expect(rows).toEqual([]);
      const attempts = await gamesService.invocations(principal, snapshot.gameId);
      expect(attempts.turns[0]?.attempts).toHaveLength(name === "extra fields" ? 1 : 3);
      expect(JSON.stringify(attempts)).not.toContain("sentinel");
    },
  );
});
