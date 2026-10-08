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

describe("AiTurnRunner", () => {
  it("paces from acknowledgement, reschedules speed changes, and serializes inference", async () => {
    const details = matchDetails();
    const h = matchHarness(details);
    h.keys();
    const first = Promise.withResolvers<GameSnapshot>();
    h.api.turn.mockReturnValueOnce(first.promise).mockReturnValue(new Promise(() => undefined));
    const starting = h.session.created(details);
    await vi.advanceTimersByTimeAsync(5000);
    h.runner.setSpeed(500);
    await h.runner.continue(false);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    expect(h.store.get()).toMatchObject({ thinking: true, canMove: false });
    h.seed(snapshot(["e2e4"]));
    first.resolve(snapshot(["e2e4"]));
    await starting;
    await vi.advanceTimersByTimeAsync(499);
    h.runner.setSpeed(1500);
    await vi.advanceTimersByTimeAsync(1499);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.api.turn).toHaveBeenCalledTimes(2);
    expect(h.api.turn.mock.calls[1]?.[0]).toMatchObject({ expectedVersion: 1, step: false });
  });

  it("keeps a failed turn's identity and never schedules a transport retry", async () => {
    const details = matchDetails();
    const h = matchHarness(details);
    h.keys();
    h.api.turn.mockRejectedValueOnce(new ApiFailure("timeout"));
    await h.session.created(details);
    expect(h.store.getActivity().turn).toEqual({
      phase: "uncertain",
      command: h.api.turn.mock.calls[0]?.[0],
    });
    expect(h.store.get()).toMatchObject({ phase: "uncertain", thinking: false, canMove: false });
    await vi.advanceTimersByTimeAsync(20_000);
    await h.runner.continue(false);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    await h.commands.recover();
    expect(h.store.getActivity().turn).toEqual({ phase: "idle", command: null });
    expect(h.store.snapshot().state).toBe("paused");
  });

  it("steps only one paused AI move and requires no human-seat credential", async () => {
    const h = matchHarness(matchDetails("black"));
    await h.enter();
    h.seats.setKey("white", "white-secret");
    const accepted = snapshot(["e2e4"], { version: 2, state: "paused", legalMoves: [] });
    h.api.turn.mockImplementationOnce(async () => {
      h.seed(accepted);
      return accepted;
    });
    await h.runner.continue(true);
    expect(h.api.turn.mock.calls[0]?.[0]).toMatchObject({ step: true, expectedVersion: 1 });
    expect(h.store.get()).toMatchObject({
      thinking: false,
      details: { snapshot: accepted },
      canMove: false,
    });
    await h.runner.continue(true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
  });
});
