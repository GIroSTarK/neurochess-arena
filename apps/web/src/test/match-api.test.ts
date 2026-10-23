import type { GameDetails } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { ApiFailure } from "../api/failures";

import { OTHER_GAME_ID, snapshot } from "./fixtures";
import { createMatchApiFixture } from "./match-api";

const seat = { type: "ai", provider: "openai", modelId: "fixture", parameters: {} } as const;
const details: GameDetails = {
  snapshot: snapshot(),
  configuration: { mode: "ai_vs_ai", seats: { white: seat, black: seat } },
};

describe("match API fixture", () => {
  it("keeps a non-default game ID through lifecycle and telemetry reads", async () => {
    const initial = {
      ...details,
      snapshot: snapshot(["e2e4"], { gameId: OTHER_GAME_ID, version: 7 }),
    };
    const { api, readSnapshot } = createMatchApiFixture(initial);
    expect(readSnapshot()).toBe(initial.snapshot);
    const signal = new AbortController().signal;
    const paused = await api.lifecycle(
      {
        gameId: OTHER_GAME_ID,
        expectedVersion: 7,
        commandId: crypto.randomUUID(),
        action: "pause",
      },
      signal,
    );

    expect(paused).toEqual({ ...initial.snapshot, state: "paused", version: 8, legalMoves: [] });
    expect(readSnapshot()).toBe(paused);
    await expect(api.details(OTHER_GAME_ID, signal)).resolves.toEqual({
      ...initial,
      snapshot: paused,
    });
    await expect(api.invocations(OTHER_GAME_ID, signal)).resolves.toEqual({
      gameId: OTHER_GAME_ID,
      version: 8,
      turns: [],
    });
  });

  it.each(["pause", "resume", "abort"] as const)(
    "preserves seeded position fields when applying %s",
    async (action) => {
      const fixture = createMatchApiFixture(details);
      const position = snapshot(["e2e4", "e7e5"]);
      const seeded = snapshot(["e2e4", "e7e5"], {
        gameId: OTHER_GAME_ID,
        version: 9,
        pgn: position.pgn.replace('[Event "?"]', '[Event "Seeded game"]'),
        ...(action === "resume" ? { state: "paused", legalMoves: [] } : {}),
      });
      fixture.seedSnapshot(seeded);
      expect(fixture.readSnapshot()).toBe(seeded);
      const signal = new AbortController().signal;
      const updated = await fixture.api.lifecycle(
        { gameId: OTHER_GAME_ID, expectedVersion: 9, commandId: crypto.randomUUID(), action },
        signal,
      );

      expect(updated).toEqual({
        ...seeded,
        version: 10,
        state: action === "resume" ? "active" : action === "abort" ? "aborted" : "paused",
        legalMoves: action === "resume" ? position.legalMoves : [],
        terminationReason: action === "abort" ? "aborted" : null,
      });
      await expect(fixture.api.snapshot(OTHER_GAME_ID, signal)).resolves.toEqual(updated);
      expect(fixture.readSnapshot()).toBe(updated);
      await expect(fixture.api.details(OTHER_GAME_ID, signal)).resolves.toEqual({
        ...details,
        snapshot: updated,
      });
      await expect(fixture.api.invocations(OTHER_GAME_ID, signal)).resolves.toEqual({
        gameId: OTHER_GAME_ID,
        version: 10,
        turns: [],
      });
      if (action === "abort") {
        await expect(fixture.api.replay(OTHER_GAME_ID, signal)).resolves.toEqual({
          snapshot: updated,
          initialFen: snapshot().fen,
        });
      }
    },
  );

  it("returns the current seeded snapshot on a version conflict without changing it", async () => {
    const fixture = createMatchApiFixture(details);
    const current = snapshot(["e2e4"], { gameId: OTHER_GAME_ID, version: 4 });
    fixture.seedSnapshot(current);
    const signal = new AbortController().signal;

    await expect(
      fixture.api.lifecycle(
        {
          gameId: OTHER_GAME_ID,
          expectedVersion: 3,
          commandId: crypto.randomUUID(),
          action: "abort",
        },
        signal,
      ),
    ).rejects.toMatchObject({
      name: "ApiFailure",
      kind: "api",
      code: "GAME_CONFLICT",
      currentSnapshot: current,
    });
    expect(fixture.readSnapshot()).toBe(current);
    await expect(fixture.api.snapshot(OTHER_GAME_ID, signal)).resolves.toBe(current);
    await expect(fixture.api.invocations(OTHER_GAME_ID, signal)).resolves.toEqual({
      gameId: OTHER_GAME_ID,
      version: 4,
      turns: [],
    });
  });

  it("isolates lifecycle state, seeding and response overrides between instances", async () => {
    const initial = details;
    const first = createMatchApiFixture(initial);
    const second = createMatchApiFixture(initial);
    const signal = new AbortController().signal;
    await first.api.lifecycle(
      {
        gameId: initial.snapshot.gameId,
        expectedVersion: 0,
        commandId: crypto.randomUUID(),
        action: "pause",
      },
      signal,
    );
    await expect(second.api.snapshot(initial.snapshot.gameId, signal)).resolves.toEqual(
      initial.snapshot,
    );

    const seeded = snapshot(["e2e4"], { gameId: OTHER_GAME_ID, version: 6 });
    first.seedSnapshot(seeded);
    expect(first.readSnapshot()).toBe(seeded);
    expect(second.readSnapshot()).toBe(initial.snapshot);
    first.api.snapshot.mockRejectedValueOnce(new ApiFailure("network"));
    await expect(first.api.snapshot(OTHER_GAME_ID, signal)).rejects.toEqual(
      new ApiFailure("network"),
    );
    await expect(first.api.snapshot(OTHER_GAME_ID, signal)).resolves.toEqual(seeded);
    await expect(second.api.details(initial.snapshot.gameId, signal)).resolves.toEqual(initial);
    await expect(second.api.invocations(initial.snapshot.gameId, signal)).resolves.toEqual({
      gameId: initial.snapshot.gameId,
      version: 0,
      turns: [],
    });
  });
});
