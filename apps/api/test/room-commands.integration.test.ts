import { randomUUID } from "node:crypto";

import { gameSnapshotSchema } from "@neurochess/contracts";
import { gameCommands, gameSlots } from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createGameService } from "../src/games/service.js";

import { command, FOOLS_MATE, KNIGHT_CYCLE } from "./helpers.js";
import { RoomApiHarness } from "./room-api-helpers.js";

const harness = new RoomApiHarness();
afterEach(() => harness.dispose());

describe("authoritative private human commands", () => {
  it.each([
    { color: "white" as const, moves: FOOLS_MATE, result: "0-1", reason: "checkmate" },
    {
      color: "black" as const,
      moves: [...KNIGHT_CYCLE, ...KNIGHT_CYCLE],
      result: "1/2-1/2",
      reason: "threefold_repetition",
    },
  ])(
    "plays both seats to $reason and restores all history between turns",
    async ({ color, moves, result, reason }) => {
      const { api, owner, invitation } = await harness.room(color);
      const opponent = await harness.guest(api);
      const outsider = await harness.guest(api);
      const joined = await harness.join(api, opponent.cookie, invitation, randomUUID());
      const gameId = joined.snapshot.gameId;
      let snapshot = joined.snapshot;
      const restarted = await harness.createAuthenticatedApi();
      for (const move of moves) {
        const player = snapshot.turn === color ? owner : opponent;
        const other = player === owner ? opponent : owner;
        const input = command(snapshot, move);
        const forbidden = await harness.post(api, other.cookie, `/games/${gameId}/moves`, input);
        expect(forbidden.statusCode).toBe(403);
        const illegal = await harness.post(api, player.cookie, `/games/${gameId}/moves`, {
          ...input,
          move: "a1a8",
        });
        expect(illegal.statusCode).toBe(422);
        const accepted = await harness.post(
          restarted,
          player.cookie,
          `/games/${gameId}/moves`,
          input,
        );
        expect(accepted.statusCode, accepted.body).toBe(200);
        snapshot = gameSnapshotSchema.parse(accepted.json());
        expect((await harness.view(api, other.cookie, gameId)).snapshot).toEqual(snapshot);
        const duplicate = await harness.post(api, player.cookie, `/games/${gameId}/moves`, input);
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json()).toMatchObject({
          code: "GAME_CONFLICT",
          currentSnapshot: snapshot,
        });
        for (const expectedVersion of [input.expectedVersion, snapshot.version + 1]) {
          const stale = await harness.post(api, player.cookie, `/games/${gameId}/moves`, {
            ...input,
            commandId: randomUUID(),
            expectedVersion,
          });
          expect(stale.statusCode).toBe(409);
          expect(stale.json()).toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: snapshot });
        }
        const changedDuplicate = await harness.post(
          api,
          other.cookie,
          `/games/${gameId}/lifecycle`,
          {
            gameId,
            action: "abort",
            expectedVersion: snapshot.version,
            commandId: input.commandId,
          },
        );
        expect(changedDuplicate.json()).toMatchObject({
          code: "GAME_CONFLICT",
          currentSnapshot: snapshot,
        });
        const stale = await harness.post(api, outsider.cookie, `/games/${gameId}/moves`, input);
        expect(stale.statusCode).toBe(404);
        expect(stale.json()).not.toHaveProperty("currentSnapshot");
      }
      expect(snapshot).toMatchObject({
        state: "completed",
        result,
        terminationReason: reason,
        version: moves.length + 1,
      });
      expect(
        await api.database.db.select().from(gameCommands).where(eq(gameCommands.gameId, gameId)),
      ).toHaveLength(moves.length + 1);
      expect(
        await api.database.db.select().from(gameSlots).where(eq(gameSlots.gameId, gameId)),
      ).toHaveLength(0);
      for (const cookie of [owner.cookie, opponent.cookie]) {
        expect(
          (await api.app.inject({ url: `/games/${gameId}/replay`, headers: { cookie } })).json(),
        ).toMatchObject({ snapshot });
        expect(
          (await api.app.inject({ url: `/games/${gameId}/pgn`, headers: { cookie } })).json(),
        ).toEqual({ gameId, version: snapshot.version, pgn: snapshot.pgn });
      }
    },
  );

  it.each(["white", "black"] as const)(
    "permits only self-resignation, including the %s seat off turn",
    async (color) => {
      const { api, owner, invitation } = await harness.room(color);
      const opponent = await harness.account(api);
      const joined = await harness.join(api, opponent.cookie, invitation, randomUUID());
      let snapshot = joined.snapshot;
      const gameId = snapshot.gameId;
      if (color === "white") {
        const moved = await harness.post(
          api,
          owner.cookie,
          `/games/${gameId}/moves`,
          command(snapshot, "e2e4"),
        );
        expect(moved.statusCode).toBe(200);
        snapshot = gameSnapshotSchema.parse(moved.json());
      }
      const input = {
        gameId,
        expectedVersion: snapshot.version,
        commandId: randomUUID(),
        action: "resign",
        losingColor: color,
      };
      expect(
        (await harness.post(api, opponent.cookie, `/games/${gameId}/lifecycle`, input)).statusCode,
      ).toBe(403);
      const resign = await harness.post(api, owner.cookie, `/games/${gameId}/lifecycle`, input);
      expect(resign.statusCode, resign.body).toBe(200);
      expect(resign.json()).toMatchObject({
        state: "completed",
        terminationReason: "human_resignation",
        result: color === "white" ? "0-1" : "1-0",
      });
      expect(
        (await harness.post(api, owner.cookie, `/games/${gameId}/lifecycle`, input)).json(),
      ).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: gameSnapshotSchema.parse(resign.json()),
      });
      expect(
        await api.database.db.select().from(gameSlots).where(eq(gameSlots.gameId, gameId)),
      ).toHaveLength(0);
    },
  );

  it("denies waiting resignation, generic Pause/Resume and AI paths; only the owner may close", async () => {
    const { api, owner, room, invitation } = await harness.room();
    const gameId = room.snapshot.gameId;
    const lifecycle = (action: string, expectedVersion: number, cookie = owner.cookie) =>
      harness.post(api, cookie, `/games/${gameId}/lifecycle`, {
        gameId,
        expectedVersion,
        commandId: randomUUID(),
        action,
        ...(action === "resign" ? { losingColor: "white" } : {}),
      });
    expect((await lifecycle("resign", 0)).statusCode).toBe(409);
    for (const action of ["pause", "resume"]) {
      expect((await lifecycle(action, 0)).statusCode).toBe(403);
    }
    const opponent = await harness.guest(api);
    await harness.join(api, opponent.cookie, invitation, randomUUID());
    for (const action of ["pause", "resume"]) {
      expect((await lifecycle(action, 1)).statusCode).toBe(403);
    }
    expect((await lifecycle("abort", 1, opponent.cookie)).statusCode).toBe(403);
    expect(
      (
        await harness.post(api, opponent.cookie, `/rooms/${gameId}/invitation`, {
          gameId,
          expectedVersion: 1,
          commandId: randomUUID(),
          action: "replace",
        })
      ).statusCode,
    ).toBe(403);
    for (const endpoint of ["controller", "ai-turn"]) {
      const response = await harness.post(api, owner.cookie, `/games/${gameId}/${endpoint}`, {
        gameId,
        expectedVersion: 1,
        controllerId: randomUUID(),
        ...(endpoint === "controller"
          ? { action: "acquire" }
          : { commandId: randomUUID(), apiKey: "unused-fixture-key" }),
      });
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(
      (
        await api.app.inject({
          url: `/games/${gameId}/invocations`,
          headers: { cookie: owner.cookie },
        })
      ).statusCode,
    ).toBe(403);
    const service = createGameService(api.repository, { nodeEnv: "test", sandboxEnabled: true });
    await service.expireControllers();
    expect((await harness.view(api, owner.cookie, gameId)).snapshot.state).toBe("active");
    const close = await lifecycle("abort", 1);
    expect(close.statusCode).toBe(200);
    expect(close.json()).toMatchObject({ state: "aborted", result: "*", version: 2 });
    expect(await api.repository.write((tx) => tx.getAiController(gameId))).toBeUndefined();
    expect(await api.repository.read((tx) => tx.getModelInvocations(gameId))).toEqual([]);
  });
});
