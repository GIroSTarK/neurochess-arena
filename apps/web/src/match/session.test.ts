import type { GameSnapshot } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RequestRateLimitFailure } from "../api/failures";
import { FOOLS_MATE, GAME_ID, OTHER_GAME_ID, snapshot } from "../test/fixtures";
import { cleanupMatches, matchDetails, matchHarness } from "../test/match-session";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanupMatches();
  vi.useRealTimers();
});

describe("MatchSession", () => {
  it("shows application throttling separately from provider quota and waits for explicit recovery", async () => {
    const h = matchHarness(matchDetails());
    await h.enter();
    h.api.lifecycle.mockClear();
    h.session.fail(new RequestRateLimitFailure(60));
    expect(h.store.get()).toMatchObject({
      phase: "uncertain",
      issue: { kind: "notice", code: "rateLimited" },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.api.lifecycle).not.toHaveBeenCalled();
    expect(h.api.turn).not.toHaveBeenCalled();
  });
  it.each(["enter", "created"] as const)(
    "rejects room details on %s before AI recovery, telemetry or controller work",
    async (entry) => {
      const details = {
        ...matchDetails(),
        configuration: {
          mode: "human_vs_human" as const,
          seats: { white: { type: "human" as const }, black: { type: "human" as const } },
        },
      };
      const h = matchHarness(details);
      if (entry === "enter") await h.enter();
      else await h.session.created(details);
      expect(h.store.get()).toMatchObject({ phase: "unavailable", details: null, canMove: false });
      for (const operation of [h.api.lifecycle, h.api.controller, h.api.invocations, h.api.turn]) {
        expect(operation).not.toHaveBeenCalled();
      }
    },
  );
  it("clears every published private slice together and fences late work across lifetimes", async () => {
    const details = matchDetails();
    const h = matchHarness(details);
    h.keys();
    const pending = Promise.withResolvers<GameSnapshot>();
    h.api.turn.mockReturnValueOnce(pending.promise);
    const starting = h.session.created(details);
    await vi.advanceTimersByTimeAsync(0);
    const observed = vi.fn(() => h.store.get());
    h.store.subscribe(observed);
    h.session.endLifetime();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.results[0]?.value).toMatchObject({
      details: null,
      invocations: null,
      thinking: false,
      canMove: false,
      pendingMove: false,
      pendingControl: false,
      keys: { white: false, black: false },
    });
    await h.session.enter({ kind: "setup" });
    const current = h.store.get();
    pending.resolve(snapshot(["e2e4"]));
    await starting;
    expect(h.store.get()).toBe(current);
  });

  it("rejects wrong-game and regressing snapshots without invalidating the accepted archive", async () => {
    const initial = { ...matchDetails(), snapshot: snapshot(FOOLS_MATE) };
    const h = matchHarness(initial);
    await h.enter();
    const current = h.store.get();
    h.session.adopt({ ...initial.snapshot, gameId: OTHER_GAME_ID });
    h.session.adopt(snapshot(["e2e4"]));
    expect(h.store.get()).toBe(current);
    expect(h.store.get().replay?.snapshot.gameId).toBe(GAME_ID);
    expect(h.api.controller).not.toHaveBeenCalled();
  });
});
