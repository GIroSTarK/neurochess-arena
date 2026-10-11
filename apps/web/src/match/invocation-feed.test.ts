import type { GameInvocations } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../api/failures";
import {
  estimatedCost,
  invocationRecords,
  pricedInvocationRecords,
  telemetryDetails,
} from "../test/ai-invocations";
import { snapshot } from "../test/fixtures";
import { cleanupMatches, matchDetails, matchHarness } from "../test/match-session";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanupMatches();
  vi.useRealTimers();
});

describe("InvocationFeed", () => {
  it("refreshes a late discarded estimate at the same terminal revision without dispatching a turn", async () => {
    const details = {
      ...telemetryDetails,
      snapshot: snapshot(["e2e4", "e7e5"], {
        state: "aborted",
        terminationReason: "aborted",
        legalMoves: [],
      }),
    };
    const records = pricedInvocationRecords();
    const first = records.turns[0]!.attempts[0]!;
    records.turns.push({
      id: crypto.randomUUID(),
      ply: 3,
      color: "white",
      acceptedMovePly: null,
      invalidOutputCount: 0,
      attempts: [
        {
          ...first,
          id: crypto.randomUUID(),
          outcome: "interrupted",
          error: null,
          durationMs: null,
          usage: null,
          cost: { status: "unavailable", reason: "dispatch_unknown" },
        },
      ],
    });
    const h = matchHarness(details);
    h.api.invocations.mockResolvedValue(records);
    await h.enter();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get().invocations?.turns[2]!.attempts[0]!.cost).toEqual({
      status: "unavailable",
      reason: "dispatch_unknown",
    });
    const updated = structuredClone(records);
    const late = updated.turns[2]!.attempts[0]!;
    Object.assign(late, {
      outcome: "discarded",
      durationMs: 900,
      cost: estimatedCost("0.000000000009", late),
    });
    h.api.invocations.mockResolvedValue(updated);
    await h.invocations.load();
    expect(h.store.get().invocations?.turns[2]!.attempts[0]!.cost).toMatchObject({
      status: "estimated",
      amount: "0.000000000009",
    });
    expect(h.store.get().details?.snapshot).toEqual(details.snapshot);
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  it("cannot restore private cost data from a read completed after an identity lifetime ends", async () => {
    const h = matchHarness(telemetryDetails);
    await h.enter();
    const old = Promise.withResolvers<GameInvocations>();
    h.api.invocations.mockReturnValueOnce(old.promise);
    const reading = h.invocations.load();
    await h.session.enter({ kind: "setup" });
    old.resolve({ ...pricedInvocationRecords(), version: 3 });
    await reading;
    expect(h.store.get()).toMatchObject({ phase: "setup", details: null, invocations: null });
  });
  it("retains received totals across revisions and a failed refresh", async () => {
    const h = matchHarness(telemetryDetails);
    await h.enter();
    const records = { ...invocationRecords(), version: 3 };
    h.api.invocations.mockResolvedValueOnce(records);
    await h.invocations.load();
    const refresh = Promise.withResolvers<GameInvocations>();
    h.api.invocations.mockReturnValueOnce(refresh.promise);
    const next = { ...h.store.snapshot(), version: 4 };
    h.seed(next);
    h.session.adopt(next);
    expect(h.store.get()).toMatchObject({
      invocations: records,
      invocationsMoveCount: 2,
      invocationsLoading: true,
    });
    refresh.reject(new ApiFailure("network"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get()).toMatchObject({
      invocations: records,
      invocationsMoveCount: 2,
      invocationsLoading: false,
      invocationsError: true,
    });
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  it("ignores a superseded read's access failure without clearing the current game", async () => {
    const h = matchHarness(matchDetails("white"));
    await h.enter();
    const old = Promise.withResolvers<GameInvocations>();
    h.api.invocations.mockReturnValueOnce(old.promise);
    const reading = h.invocations.load();
    const next = snapshot([], { version: 2, state: "paused", legalMoves: [] });
    h.seed(next);
    h.session.adopt(next);
    old.reject(new ApiFailure("api", "FORBIDDEN"));
    await reading;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get()).toMatchObject({
      phase: "ready",
      details: { snapshot: next },
      invocations: { version: 2 },
    });
  });

  it("polls human-turn records without dispatch and clears private data on access loss", async () => {
    const details = matchDetails("white");
    const h = matchHarness(details);
    h.keys();
    await h.session.created(details);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.api.invocations).toHaveBeenCalledTimes(2);
    expect(h.store.get().canMove).toBe(true);
    h.api.invocations.mockRejectedValueOnce(new ApiFailure("api", "PROFILE_REQUIRED"));
    await h.invocations.load();
    const denied = h.store.get();
    expect(denied).toMatchObject({
      phase: "unavailable",
      details: null,
      invocations: null,
      keys: { white: false, black: false },
      canMove: false,
    });
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.store.get()).toBe(denied);
    expect(h.api.turn).not.toHaveBeenCalled();
    expect(h.api.bootstrap).not.toHaveBeenCalled();
  });
});
