import type { StoredAnalysisSample } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AnalysisTarget, PROFILE_ID } from "../analysis/protocol";
import { AnalysisScheduler } from "../analysis/scheduler";
import type { SearchOutcome } from "../analysis/worker-client";
import { type AnalysisApi, AnalysisProfileObsolete } from "../api/analysis-client";
import { ApiFailure } from "../api/failures";
import { deterministicDigest, settle } from "../test/analysis";
import { snapshot } from "../test/fixtures";

import { GameAnalysisController } from "./analysis-controller";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  deterministicDigest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness(api?: AnalysisApi, moves: string[] = []) {
  const calls: AnalysisTarget[] = [];
  let finish: (result: SearchOutcome) => void = () => undefined;
  let disposed = false;
  let retries = 0;
  const controller = new GameAnalysisController(
    snapshot(moves),
    api,
    (history) =>
      new AnalysisScheduler(history, {
        analyze(target) {
          calls.push(target);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        cancel() {
          finish({ status: "cancelled" });
        },
        suspend() {
          finish({ status: "cancelled" });
        },
        dispose() {
          disposed = true;
        },
        retry() {
          retries++;
        },
      }),
  );
  const advance = async (ms = 250) => {
    vi.advanceTimersByTime(ms);
    await settle();
  };
  const complete = (value = 10) => {
    const identity = calls.at(-1)!;
    finish({
      status: "ready",
      sample: {
        ...identity,
        generation: 1,
        depth: 8,
        durationMs: 40,
        score: { kind: "cp", value },
      },
    });
  };
  controller.start();
  return {
    controller,
    calls,
    complete,
    advance,
    late: () => finish,
    disposed: () => disposed,
    retries: () => retries,
    fail: () => finish({ status: "unavailable", reason: "engine_crashed", fatal: true }),
  };
}

function storage() {
  const rows = new Map<number, StoredAnalysisSample>();
  const api: AnalysisApi = {
    read: vi.fn<AnalysisApi["read"]>(async (gameId) => ({
      gameId,
      samples: [...rows.values()],
      nextCursor: null,
    })),
    write: vi.fn<AnalysisApi["write"]>(async (gameId, samples) => {
      for (const sample of samples) {
        if (!rows.has(sample.ply)) {
          rows.set(sample.ply, { ...sample, recordedAt: "2026-10-11T00:00:00.000Z" });
        }
      }
      return { gameId, samples: samples.map((sample) => rows.get(sample.ply)!) };
    }),
  };
  return { api, rows };
}

describe("game analysis lifetime and persistence", () => {
  it("analyzes ply zero and accepted extensions without treating revisions as moves", async () => {
    const h = harness();
    await h.advance(0);
    h.complete();
    await settle();
    expect(h.controller.getSnapshot().plies[0]).toMatchObject({ status: "ready", saved: "memory" });
    h.controller.update(snapshot([], { version: 5 }), 0);
    await h.advance();
    expect(h.calls).toHaveLength(1);
    h.controller.update(snapshot(["e2e4"]), 1);
    await h.advance();
    expect(h.calls.at(-1)?.moves).toEqual(["e2e4"]);
    h.controller.dispose();
  });

  it("retains unsaved samples on failure and retries only on explicit request", async () => {
    const s = storage();
    const write = vi.spyOn(s.api, "write").mockRejectedValueOnce(new ApiFailure("network"));
    const h = harness(s.api);
    await settle();
    await h.advance(0);
    h.complete();
    await settle();
    expect(h.controller.getSnapshot()).toMatchObject({
      persistence: "error",
      plies: [{ saved: "unsaved", sample: { score: { value: 10 } } }],
    });
    await h.advance(20_000);
    expect(write).toHaveBeenCalledTimes(1);
    h.controller.retryPersistence();
    await settle();
    expect(h.controller.getSnapshot().plies[0]?.saved).toBe("saved");
    expect(write).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });

  it("accepts the server's retained equal-depth sample", async () => {
    const s = storage();
    const h = harness(s.api);
    await settle();
    await h.advance(0);
    const target = h.calls[0]!;
    s.rows.set(0, {
      ...target,
      depth: 8,
      durationMs: 50,
      score: { kind: "cp", value: 99 },
      recordedAt: "2026-10-11T00:00:00.000Z",
    });
    h.complete();
    await settle();
    expect(h.controller.getSnapshot().plies[0]).toMatchObject({
      saved: "saved",
      sample: { score: { value: 99 } },
    });
    h.controller.dispose();
  });

  it("loads saved samples before engine startup and keeps older profiles during failed backfill", async () => {
    const s = storage();
    const first = harness(s.api);
    await settle();
    await first.advance(0);
    first.complete();
    await settle();
    first.controller.dispose();
    const loaded = harness(s.api);
    await settle();
    await loaded.advance(0);
    expect(loaded.calls).toEqual([]);
    expect(loaded.controller.getSnapshot().plies[0]?.saved).toBe("saved");
    loaded.controller.dispose();
    s.rows.set(0, { ...s.rows.get(0)!, profileId: "previous-v0" });
    const old = harness(s.api);
    await settle();
    await old.advance(0);
    old.fail();
    await settle();
    expect(old.controller.getSnapshot().plies[0]).toMatchObject({
      status: "unavailable",
      saved: "saved",
      sample: { profileId: "previous-v0" },
    });
    old.controller.retry(0);
    await old.advance(0);
    expect(old.retries()).toBe(1);
    old.controller.dispose();
  });

  it("requires reload on profile_obsolete without save or worker restart loops", async () => {
    const s = storage();
    vi.spyOn(s.api, "write").mockRejectedValue(new AnalysisProfileObsolete());
    const h = harness(s.api);
    await settle();
    await h.advance(0);
    h.complete();
    await settle();
    h.controller.retryPersistence();
    h.controller.retry(0);
    await h.advance(10_000);
    expect(h.controller.getSnapshot()).toMatchObject({
      persistence: "obsolete",
      plies: [{ saved: "unsaved", sample: { profileId: PROFILE_ID } }],
    });
    expect(s.api.write).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it.each([true, false])(
    "reauthorizes obsolete analysis on visibility return (allowed: %s)",
    async (allowed) => {
      const s = storage();
      vi.spyOn(s.api, "write").mockRejectedValue(new AnalysisProfileObsolete());
      const h = harness(s.api);
      await settle();
      await h.advance(0);
      h.complete();
      await settle();
      h.controller.suspend();
      const authorize = vi.fn(async () => allowed);
      await h.controller.resume(authorize);
      await h.advance(5_000);
      expect(authorize).toHaveBeenCalledOnce();
      expect(h.calls).toHaveLength(1);
      expect(s.api.write).toHaveBeenCalledOnce();
      expect(h.controller.getSnapshot()).toMatchObject(
        allowed
          ? { persistence: "obsolete", suspended: false, plies: [{ saved: "unsaved" }] }
          : { gameId: null, plies: [] },
      );
      h.controller.dispose();
    },
  );

  it.each(["read", "write"] as const)("fences late %s responses after disposal", async (kind) => {
    const s = storage();
    let finish!: (value: {
      gameId: string;
      samples: StoredAnalysisSample[];
      nextCursor: null;
    }) => void;
    vi.spyOn(s.api, kind).mockImplementation(
      () =>
        new Promise<{ gameId: string; samples: StoredAnalysisSample[]; nextCursor: null }>(
          (resolve) => {
            finish = resolve;
          },
        ),
    );
    const h = harness(s.api);
    await settle();
    if (kind === "write") {
      await h.advance(0);
      h.complete();
      await settle();
    }
    h.controller.dispose();
    finish({ gameId: snapshot().gameId, samples: [], nextCursor: null });
    await settle();
    expect(h.controller.getSnapshot()).toMatchObject({ gameId: null, plies: [] });
    expect(h.disposed()).toBe(true);
  });

  it("suspends work and uploads, reauthorizes before resuming, and clears on access denial", async () => {
    const h = harness();
    await h.advance(0);
    const late = h.late();
    const target = h.calls[0]!;
    h.controller.suspend();
    late({
      status: "ready",
      sample: {
        ...target,
        generation: 1,
        depth: 8,
        durationMs: 20,
        score: { kind: "cp", value: 20 },
      },
    });
    await settle();
    expect(h.controller.getSnapshot().plies[0]).toMatchObject({ status: "suspended" });
    let authorize!: (allowed: boolean) => void;
    const pending = h.controller.resume(
      () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    );
    await h.advance(5_000);
    expect(h.calls).toHaveLength(1);
    authorize(false);
    await pending;
    expect(h.controller.getSnapshot().plies).toEqual([]);
  });

  it("does not upload a second batch while a prior write is unresolved", async () => {
    const s = storage();
    let finish!: () => void;
    const original = s.api.write;
    vi.spyOn(s.api, "write").mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          finish = () => {
            void original(...args).then(resolve);
          };
        }),
    );
    const h = harness(s.api, ["e2e4"]);
    await settle();
    await h.advance(0);
    h.complete();
    await settle();
    await h.advance();
    h.complete();
    await settle();
    expect(s.api.write).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().plies.filter((ply) => ply.saved === "unsaved")).toHaveLength(
      2,
    );
    finish();
    await settle();
    expect(h.controller.getSnapshot().plies.every((ply) => ply.saved === "saved")).toBe(true);
    h.controller.dispose();
  });
  it("requires an explicit identical save retry after hiding interrupts a write", async () => {
    const s = storage();
    vi.spyOn(s.api, "write").mockImplementationOnce(() => new Promise(() => undefined));
    const h = harness(s.api);
    await settle();
    await h.advance(0);
    h.complete();
    await settle();
    h.controller.suspend();
    await h.controller.resume(async () => true);
    await h.advance(5_000);
    expect(s.api.write).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().persistence).toBe("error");
    h.controller.retryPersistence();
    await settle();
    expect(h.controller.getSnapshot().plies[0]?.saved).toBe("saved");
    h.controller.dispose();
  });
});
