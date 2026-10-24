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
    expect(h.api.lifecycle).not.toHaveBeenCalled();
    expect(h.api.turn.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 0, step: false });
    h.runner.setSpeed(500);
    await h.runner.resume();
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

  it("resumes with one lifecycle command before dispatching an ordinary AI turn", async () => {
    const h = matchHarness();
    await h.enter();
    h.seats.setKey("white", "white-secret");
    h.seats.setKey("black", "black-secret");
    h.api.lifecycle.mockClear();
    const accepted = snapshot(["e2e4"], { version: 3 });
    h.api.turn.mockImplementationOnce(async () => {
      expect(h.store.snapshot()).toMatchObject({ state: "active", version: 2 });
      h.seed(accepted);
      return accepted;
    });

    await h.runner.resume();
    await h.runner.resume();

    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
    expect(h.api.lifecycle.mock.calls[0]?.[0]).toMatchObject({
      action: "resume",
      expectedVersion: 1,
      controllerId: h.lease.id,
    });
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    expect(h.api.turn.mock.calls[0]?.[0]).toMatchObject({ step: false, expectedVersion: 2 });
    expect(h.store.snapshot()).toEqual(accepted);
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
    await h.runner.resume();
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    await h.commands.recover();
    expect(h.store.getActivity().turn).toEqual({ phase: "idle", command: null });
    expect(h.store.snapshot().state).toBe("paused");
  });

  it.each(["ai", "human"])("steps one paused AI move against an %s seat", async (opponent) => {
    const h = matchHarness(matchDetails(opponent === "human" ? "black" : undefined));
    await h.enter();
    h.seats.setKey("white", "white-secret");
    if (opponent === "ai") h.seats.setKey("black", "black-secret");
    const states: string[] = [];
    const unsubscribe = h.store.subscribe(() => {
      const state = h.store.get().details?.snapshot.state;
      if (state) states.push(state);
    });
    const response = Promise.withResolvers<GameSnapshot>();
    const accepted = snapshot(["e2e4"], { version: 2, state: "paused", legalMoves: [] });
    h.api.turn.mockReturnValueOnce(response.promise);
    const stepping = h.runner.step();
    await vi.advanceTimersByTimeAsync(0);
    await h.runner.step();
    expect(h.store.get()).toMatchObject({
      thinking: true,
      details: { snapshot: { state: "paused", version: 1 } },
    });
    h.seed(accepted);
    response.resolve(accepted);
    await stepping;
    expect(h.api.turn.mock.calls[0]?.[0]).toMatchObject({ step: true, expectedVersion: 1 });
    expect(h.store.get()).toMatchObject({
      thinking: false,
      details: { snapshot: accepted },
      canMove: false,
    });
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state === "paused")).toBe(true);
    unsubscribe();
  });
});
