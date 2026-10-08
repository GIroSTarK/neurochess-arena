import type { GameSnapshot } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../api/failures";
import { snapshot } from "../test/fixtures";
import { cleanupMatches, matchDetails, matchHarness } from "../test/match-session";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanupMatches();
  vi.useRealTimers();
});

describe("MatchCommands", () => {
  it("retains an uncertain human move verbatim and recovers paused after its explicit retry", async () => {
    const details = matchDetails("white");
    const h = matchHarness(details);
    h.keys();
    await h.session.created(details);
    h.api.move.mockRejectedValueOnce(new ApiFailure("network"));
    await h.commands.move("e2e4");
    expect(h.store.get()).toMatchObject({ pendingMove: true, canMove: false, phase: "uncertain" });
    await h.commands.move("d2d4");
    h.api.move.mockImplementationOnce(async () => {
      const accepted = snapshot(["e2e4"]);
      h.seed(accepted);
      return accepted;
    });
    await h.commands.retryMove();
    expect(h.api.move.mock.calls[1]?.[0]).toEqual(h.api.move.mock.calls[0]?.[0]);
    expect(h.api.move).toHaveBeenCalledTimes(2);
    expect(h.store.get()).toMatchObject({
      pendingMove: false,
      pendingControl: false,
      canMove: false,
      details: { snapshot: { state: "paused" } },
    });
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  it("bounds recovery conflicts to three attempts and retains the final pause for explicit retry", async () => {
    const h = matchHarness();
    h.api.lifecycle.mockImplementation(async (command) => {
      throw new ApiFailure(
        "api",
        "GAME_CONFLICT",
        snapshot([], { version: command.expectedVersion + 1 }),
      );
    });
    await h.enter();
    expect(h.api.lifecycle).toHaveBeenCalledTimes(3);
    expect(h.api.lifecycle.mock.calls.map(([command]) => command.expectedVersion)).toEqual([
      0, 1, 2,
    ]);
    expect(h.store.get()).toMatchObject({
      phase: "uncertain",
      pendingControl: true,
      canMove: false,
      busy: false,
    });
    const retained = h.store.getActivity().control;
    h.api.lifecycle.mockResolvedValueOnce(
      snapshot([], { state: "paused", version: 4, legalMoves: [] }),
    );
    await h.commands.retryControl();
    expect(h.api.lifecycle.mock.calls[3]?.[0]).toEqual(retained);
    expect(h.store.get()).toMatchObject({ phase: "ready", pendingControl: false });
  });

  it("fences inference after an accepted lifecycle command", async () => {
    const details = matchDetails();
    const h = matchHarness(details);
    h.keys();
    const turn = Promise.withResolvers<GameSnapshot>();
    h.api.turn.mockReturnValueOnce(turn.promise);
    const starting = h.session.created(details);
    await vi.advanceTimersByTimeAsync(0);
    await h.commands.lifecycle("pause");
    const accepted = h.store.get();
    expect(accepted).toMatchObject({
      thinking: false,
      pendingControl: false,
      details: { snapshot: { state: "paused" } },
    });
    expect(h.api.turn.mock.calls[0]?.[2].aborted).toBe(true);
    turn.resolve(snapshot(["e2e4"]));
    await starting;
    expect(h.store.get()).toBe(accepted);
  });
});
