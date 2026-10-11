import { createGame } from "@neurochess/chess";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deterministicDigest, initialTarget, settle } from "../test/analysis";

import { type AnalysisTarget, historyDigest } from "./protocol";
import { type AnalysisHistory, AnalysisScheduler } from "./scheduler";
import type { SearchOutcome } from "./worker-client";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  deterministicDigest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function history(moves = ["e2e4", "e7e5", "g1f3", "b8c6"]): AnalysisHistory {
  const game = createGame();
  game.start();
  for (const move of moves) game.playMove(move);
  return {
    lifetime: initialTarget.lifetime,
    gameId: initialTarget.gameId,
    initialFen: initialTarget.fen,
    moves: game.snapshot().moves,
  };
}

function harness() {
  const calls: AnalysisTarget[] = [];
  let complete: ((outcome: SearchOutcome) => void) | undefined;
  let disposed = false;
  let retries = 0;
  const worker = {
    analyze(target: AnalysisTarget) {
      calls.push(target);
      return new Promise<SearchOutcome>((resolve) => {
        complete = resolve;
      });
    },
    cancel() {
      complete?.({ status: "cancelled" });
    },
    suspend() {
      complete?.({ status: "cancelled" });
    },
    retry() {
      retries++;
    },
    dispose() {
      disposed = true;
      complete?.({ status: "cancelled" });
    },
  };
  const scheduler = new AnalysisScheduler(history(), worker);
  const finish = (outcome?: SearchOutcome) => {
    const identity = calls.at(-1)!;
    complete?.(
      outcome ?? {
        status: "ready",
        sample: {
          lifetime: identity.lifetime,
          gameId: identity.gameId,
          ply: identity.ply,
          fen: identity.fen,
          historyDigest: identity.historyDigest,
          profileId: identity.profileId,
          generation: 1,
          depth: 8,
          durationMs: 50,
          score: { kind: "cp", value: 10 },
        },
      },
    );
  };
  const advance = async (ms = 250) => {
    vi.advanceTimersByTime(ms);
    await settle();
  };
  return {
    scheduler,
    calls,
    worker,
    finish,
    advance,
    disposed: () => disposed,
    retries: () => retries,
    late: () => complete!,
  };
}

describe("bounded analysis scheduling", () => {
  it("converges to the server-retained sample after losing an equal-depth write tie", async () => {
    const h = harness();
    h.scheduler.show(0);
    await h.advance(0);
    h.finish();
    await settle();
    await h.scheduler.seed(
      [
        {
          ...initialTarget,
          generation: 1,
          depth: 8,
          durationMs: 40,
          score: { kind: "cp", value: 25 },
        },
      ],
      true,
    );
    expect(h.scheduler.getState(0).sample?.score).toEqual({ kind: "cp", value: 25 });
    h.scheduler.dispose();
  });
  it.each(["cancel", "suspend", "unavailable"] as const)(
    "keeps a newly seeded ready sample when overlapping work ends with %s",
    async (end) => {
      const h = harness();
      h.scheduler.show(0);
      await h.advance(0);
      await h.scheduler.seed([
        {
          ...initialTarget,
          generation: 1,
          depth: 18,
          durationMs: 900,
          score: { kind: "cp", value: 30 },
        },
      ]);
      if (end === "cancel") h.scheduler.show(4);
      else if (end === "suspend") h.scheduler.suspend();
      else h.finish({ status: "unavailable", reason: "no_score", fatal: false });
      await settle();
      expect(h.scheduler.getState(0)).toMatchObject({ status: "ready", sample: { depth: 18 } });
      h.scheduler.dispose();
    },
  );
  it("does not replace a deeper retained sample with a shallower in-flight result", async () => {
    const h = harness();
    h.scheduler.show(0);
    await h.advance(0);
    await h.scheduler.seed([
      {
        ...initialTarget,
        generation: 1,
        depth: 18,
        durationMs: 900,
        score: { kind: "cp", value: 30 },
      },
    ]);
    h.finish();
    await settle();
    expect(h.scheduler.getState(0)).toMatchObject({
      status: "ready",
      sample: { depth: 18, score: { kind: "cp", value: 30 } },
    });
    h.scheduler.dispose();
  });

  it("rejects a seeded mate-zero score without independently verified checkmate", async () => {
    const h = harness();
    await h.scheduler.seed([
      {
        ...initialTarget,
        generation: 1,
        depth: 0,
        durationMs: 0,
        score: { kind: "mate", winner: "white", moves: 0 },
      },
    ]);
    expect(h.scheduler.getState(0).status).toBe("pending");
    h.scheduler.dispose();
  });
  it("starts at the displayed ply, idles at least 250ms, and eventually fills every gap", async () => {
    const h = harness();
    h.scheduler.show(4);
    await h.advance(0);
    expect(h.calls.map((job) => job.ply)).toEqual([4]);
    expect(h.calls[0]!.moves).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
    h.finish();
    await settle();
    await h.advance(249);
    expect(h.calls).toHaveLength(1);
    await h.advance(1);
    expect(h.calls.at(-1)!.ply).toBe(0);
    for (let ply = 0; ply < 4; ply++) {
      h.finish();
      await settle();
      await h.advance();
    }
    expect(h.calls.map((job) => job.ply)).toEqual([4, 0, 1, 2, 3]);
    for (let ply = 0; ply <= 4; ply++) expect(h.scheduler.getState(ply).status).toBe("ready");
    h.scheduler.dispose();
  });

  it("counts cancelled foreground dispatches and protects the reserved historical turn", async () => {
    const h = harness();
    h.scheduler.show(4);
    await h.advance(0);
    h.scheduler.show(3);
    await settle();
    await h.advance(0);
    h.scheduler.show(2);
    await settle();
    await h.advance(0);
    expect(h.calls.map((job) => job.ply)).toEqual([4, 3, 0]);
    h.scheduler.show(1);
    h.scheduler.show(4);
    await h.advance(2000);
    expect(h.calls).toHaveLength(3);
    h.finish();
    await settle();
    await h.advance();
    expect(h.calls.at(-1)!.ply).toBe(4);
    h.scheduler.dispose();
  });

  it("coalesces displayed targets and scans a growing canonical history instead of dropping plies", async () => {
    const h = harness();
    h.scheduler.show(4);
    await h.advance(0);
    h.scheduler.show(4);
    h.scheduler.updateHistory(history());
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    h.scheduler.updateHistory(history(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"]));
    h.scheduler.show(6);
    h.scheduler.show(5);
    h.scheduler.show(6);
    await settle();
    await h.advance(0);
    h.finish();
    await settle();
    for (let index = 0; index < 6; index++) {
      await h.advance();
      h.finish();
      await settle();
    }
    expect(new Set(h.calls.map((job) => job.ply))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
    h.scheduler.dispose();
  });

  it("skips failed plies, suspends on worker faults, and retries only after an explicit request", async () => {
    const h = harness();
    h.scheduler.show(4);
    await h.advance(0);
    h.finish({ status: "unavailable", reason: "no_score", fatal: false });
    await settle();
    await h.advance();
    expect(h.calls.at(-1)!.ply).toBe(0);
    h.finish({ status: "unavailable", reason: "engine_crashed", fatal: true });
    await settle();
    await h.advance(60000);
    h.scheduler.show(3);
    await h.advance();
    expect(h.calls).toHaveLength(2);
    expect(h.scheduler.getState(4)).toMatchObject({ status: "unavailable", reason: "no_score" });
    h.scheduler.retry(0);
    h.scheduler.retry(0);
    await h.advance();
    expect(h.retries()).toBe(1);
    expect(h.calls.at(-1)!.ply).toBe(0);
    h.scheduler.dispose();
  });

  it("retains completed samples while hidden and requires fresh authorization before resuming", async () => {
    const h = harness();
    h.scheduler.show(4);
    await h.advance(0);
    h.finish();
    await settle();
    h.scheduler.suspend();
    await h.advance(1000);
    expect(h.scheduler.getState(4).status).toBe("ready");
    expect(h.scheduler.getState(0).status).toBe("suspended");
    let authorize!: (value: boolean) => void;
    const resumed = h.scheduler.resume(
      () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    );
    await h.advance(1000);
    expect(h.calls).toHaveLength(1);
    authorize(true);
    await resumed;
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    h.scheduler.dispose();
  });

  it("preserves the owed backfill turn across hidden cancellation", async () => {
    const h = harness();
    h.scheduler.show(4);
    await h.advance(0);
    h.scheduler.show(3);
    await settle();
    await h.advance(0);
    h.scheduler.show(2);
    await settle();
    await h.advance(0);
    expect(h.calls.at(-1)!.ply).toBe(0);
    h.scheduler.suspend();
    await settle();
    await h.scheduler.resume(async () => true);
    await h.advance(0);
    expect(h.calls.at(-1)!.ply).toBe(0);
    h.scheduler.dispose();
  });

  it("clears all private state on disposal, access loss or a different lifetime; late results cannot restore it", async () => {
    for (const reason of ["dispose", "denied", "identity"] as const) {
      const h = harness();
      h.scheduler.show(4);
      await h.advance(0);
      const late = h.late();
      if (reason === "dispose") h.scheduler.dispose();
      else if (reason === "denied") {
        h.scheduler.suspend();
        await h.scheduler.resume(async () => false);
      } else h.scheduler.updateHistory({ ...history(), lifetime: "other-user" });
      late({ status: "unavailable", reason: "no_score", fatal: false });
      await settle();
      expect(h.disposed()).toBe(true);
      expect(h.scheduler.getState(4)).toEqual({ status: "suspended" });
      await h.advance(60000);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("backfills older-profile samples while retaining them if replacement fails", async () => {
    const h = harness();
    await h.scheduler.seed([
      {
        ...initialTarget,
        moves: undefined,
        profileId: "sf18-old",
        generation: 1,
        depth: 12,
        durationMs: 50,
        score: { kind: "cp", value: 5 },
      },
    ]);
    h.scheduler.show(0);
    await h.advance(0);
    expect(h.calls.at(-1)!.ply).toBe(0);
    h.finish({ status: "unavailable", reason: "no_score", fatal: false });
    await settle();
    expect(h.scheduler.getState(0)).toMatchObject({
      status: "unavailable",
      sample: { profileId: "sf18-old" },
    });
    h.scheduler.dispose();
  });

  it("rejects seeded samples for a different prefix even when the FEN matches", async () => {
    const h = harness();
    await h.scheduler.seed([
      {
        ...initialTarget,
        historyDigest: await historyDigest(["g1f3", "g8f6", "f3g1", "f6g8"]),
        depth: 8,
        durationMs: 50,
        generation: 1,
        score: { kind: "cp", value: 0 },
      },
    ]);
    expect(h.scheduler.getState(0).status).toBe("pending");
    h.scheduler.dispose();
  });
});
