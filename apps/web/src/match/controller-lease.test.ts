import type { GameSnapshot } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiRequestFailure } from "../api/ai-client";
import { snapshot } from "../test/fixtures";
import { cleanupMatches, matchDetails, matchHarness } from "../test/match-session";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanupMatches();
  vi.useRealTimers();
});

describe("ControllerLease", () => {
  it("releases human move availability immediately and ignores a late heartbeat", async () => {
    const details = matchDetails("white");
    const h = matchHarness(details);
    h.keys();
    await h.session.created(details);
    const heartbeat = Promise.withResolvers<GameSnapshot>();
    h.api.controller.mockReturnValueOnce(heartbeat.promise);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.store.get().canMove).toBe(true);
    h.lease.release();
    expect(h.store.get().canMove).toBe(false);
    heartbeat.resolve(snapshot(["e2e4"]));
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.store.snapshot().version).toBe(0);
    expect(h.api.controller).toHaveBeenCalledTimes(2);
  });

  it("stops heartbeats on a rejected lease until explicit continuation", async () => {
    const details = matchDetails("white");
    const h = matchHarness(details);
    h.keys();
    await h.session.created(details);
    h.api.controller.mockRejectedValueOnce(new AiRequestFailure("AI_CONTROLLER_LOST"));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.store.get()).toMatchObject({
      phase: "uncertain",
      canMove: false,
      issue: { code: "AI_CONTROLLER_LOST" },
    });
    expect(h.api.controller).toHaveBeenCalledTimes(2);
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  it("does not acquire an obsolete lifetime's lease", async () => {
    const h = matchHarness(matchDetails("white"));
    await h.enter();
    const pending = Promise.withResolvers<GameSnapshot>();
    h.api.controller.mockReturnValueOnce(pending.promise);
    const acquisition = h.lease.acquire(h.session.signal()!);
    h.session.endLifetime();
    pending.resolve(snapshot());
    expect(await acquisition).toBe(false);
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.store.get()).toMatchObject({ details: null, canMove: false });
    expect(h.api.controller).toHaveBeenCalledTimes(1);
  });
});
