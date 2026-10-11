import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deterministicDigest, fakeEngine, initialTarget, settle } from "../test/analysis";

import { AnalysisWorkerClient } from "./worker-client";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  deterministicDigest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const engines: ReturnType<typeof fakeEngine>[] = [];
  const client = new AnalysisWorkerClient({
    supported: () => true,
    createWorker: () => {
      const engine = fakeEngine();
      engines.push(engine);
      return engine.worker;
    },
  });
  return {
    client,
    engines,
    start: async () => {
      const result = client.analyze(initialTarget);
      await settle();
      engines[0]!.initialize();
      return { result, engine: engines[0]! };
    },
  };
}

describe("analysis worker lifecycle", () => {
  it("does not leave an old watchdog after posting a position fails", async () => {
    const { client, engines, start } = setup();
    const { result, engine } = await start();
    const post = engine.worker.postMessage.bind(engine.worker);
    engine.worker.postMessage = (command) => {
      if (command.startsWith("position")) throw new Error("transport closed");
      post(command);
    };
    engine.emit("readyok");
    expect(await result).toMatchObject({ status: "unavailable", fatal: true });
    client.retry();
    const next = client.analyze(initialTarget);
    await settle();
    vi.advanceTimersByTime(3000);
    expect(engines[1]!.terminated()).toBe(false);
    engines[1]!.initialize();
    engines[1]!.emit("readyok");
    engines[1]!.emit("info depth 1 score cp 0");
    engines[1]!.emit("bestmove e2e4");
    expect(await next).toMatchObject({ status: "ready" });
    client.dispose();
  });
  it("loads lazily, verifies options, resets each search, and keeps the deepest exact score", async () => {
    const harness = setup();
    expect(harness.engines).toHaveLength(0);
    const { result, engine } = await harness.start();
    expect(engine.commands.slice(-2)).toEqual(["ucinewgame", "isready"]);
    engine.emit("readyok");
    expect(engine.commands.slice(-2)).toEqual([
      "position startpos",
      "go depth 18 nodes 1000000 movetime 1000",
    ]);
    engine.emit(
      "info depth 4 score cp 12 pv e2e4\ninfo depth 7 score cp 22\ninfo depth 8 score cp 30 lowerbound",
    );
    engine.emit("info depth 2 score cp 11");
    vi.advanceTimersByTime(400);
    engine.emit("bestmove e2e4");
    expect(await result).toMatchObject({
      status: "ready",
      sample: {
        depth: 7,
        durationMs: 400,
        score: { kind: "cp", value: 22 },
        generation: 1,
        lifetime: "view-1",
        ply: 0,
      },
    });
    expect(JSON.stringify(await result)).not.toMatch(/pv|bestmove|e2e4/);
    clientDispose(harness.client);
  });

  it("drains cancelled bestmove before readiness and never gives its score to the next search", async () => {
    const { client, start } = setup();
    const { result, engine } = await start();
    engine.emit("readyok");
    client.cancel();
    expect(engine.commands.at(-1)).toBe("stop");
    engine.emit("readyok");
    engine.emit("info depth 18 score cp 999");
    expect(engine.commands.at(-1)).toBe("stop");
    engine.emit("bestmove e2e4");
    expect(engine.commands.at(-1)).toBe("isready");
    engine.emit("readyok");
    expect(await result).toEqual({ status: "cancelled" });
    const next = client.analyze(initialTarget);
    await settle();
    engine.emit("readyok");
    engine.emit("bestmove e2e4");
    expect(await next).toMatchObject({ status: "unavailable", reason: "no_score", fatal: false });
    clientDispose(client);
  });

  it("marks a responsive timed-out ply unavailable after bounded stop and continues without a replacement", async () => {
    const { client, engines, start } = setup();
    const { result, engine } = await start();
    engine.emit("readyok");
    vi.advanceTimersByTime(2000);
    expect(engine.commands.at(-1)).toBe("stop");
    engine.emit("info depth 4 score cp 0");
    engine.emit("bestmove e2e4");
    engine.emit("readyok");
    expect(await result).toMatchObject({
      status: "unavailable",
      reason: "search_timeout",
      fatal: false,
    });
    const next = client.analyze(initialTarget);
    await settle();
    expect(engines).toHaveLength(1);
    clientDispose(client);
    expect(await next).toEqual({ status: "cancelled" });
  });

  it("terminates a stuck search and fences late events until explicit Retry", async () => {
    const { client, engines, start } = setup();
    const { result, engine } = await start();
    engine.emit("readyok");
    const stale = engine.worker.onmessage!;
    vi.advanceTimersByTime(3000);
    expect(await result).toMatchObject({
      status: "unavailable",
      reason: "search_timeout",
      fatal: true,
    });
    expect(engine.terminated()).toBe(true);
    expect(await client.analyze(initialTarget)).toMatchObject({
      status: "unavailable",
      fatal: true,
    });
    expect(engines).toHaveLength(1);
    client.retry();
    const next = client.analyze(initialTarget);
    await settle();
    expect(engines).toHaveLength(2);
    engines[1]!.initialize();
    engines[1]!.emit("readyok");
    stale({ data: "info depth 18 score cp 999\nbestmove e2e4" } as MessageEvent);
    engines[1]!.emit("info depth 1 score cp 0");
    engines[1]!.emit("bestmove e2e4");
    expect(await next).toMatchObject({
      status: "ready",
      sample: { generation: 2, depth: 1, score: { kind: "cp", value: 0 } },
    });
    clientDispose(client);
  });

  it.each(["startup", "readiness", "cancel-stop", "cancel-readiness"] as const)(
    "enforces %s deadlines",
    async (phase) => {
      const { client, engines } = setup();
      const result = client.analyze(initialTarget);
      await settle();
      const engine = engines[0]!;
      if (phase !== "startup") engine.initialize();
      if (phase.startsWith("cancel")) {
        engine.emit("readyok");
        client.cancel();
      }
      if (phase === "cancel-readiness") engine.emit("bestmove e2e4");
      vi.advanceTimersByTime(phase === "startup" ? 15000 : 1000);
      expect(await result).toMatchObject({
        status: "unavailable",
        fatal: true,
        reason: phase === "startup" ? "initialization_timeout" : "engine_protocol_error",
      });
      expect(engine.terminated()).toBe(true);
      clientDispose(client);
    },
  );

  it("classifies missing assets, crashes, output overflow and unsupported browsers without raw errors", async () => {
    for (const [failure, reason] of [
      ["load", "engine_load_failed"],
      ["crash", "engine_crashed"],
      ["overflow", "resource_limit"],
      ["memory", "resource_limit"],
    ] as const) {
      const { client, engines } = setup();
      const result = client.analyze(initialTarget);
      await settle();
      const engine = engines[0]!;
      if (failure !== "load") {
        engine.initialize();
        engine.emit("readyok");
      }
      if (failure === "overflow") engine.emit("x".repeat(65537));
      else if (failure === "memory") engine.emit("Aborted(Cannot enlarge memory arrays)");
      else {
        engine.worker.onerror!({
          preventDefault: vi.fn(),
          message: "private",
        } as unknown as ErrorEvent);
      }
      expect(await result).toMatchObject({ status: "unavailable", reason, fatal: true });
      expect(JSON.stringify(await result)).not.toContain("private");
      clientDispose(client);
    }
    const client = new AnalysisWorkerClient({ supported: () => false });
    expect(await client.analyze(initialTarget)).toMatchObject({
      status: "unavailable",
      reason: "unsupported_browser",
    });
  });

  it("disposal during validation prevents creation and any private result", async () => {
    const { client, engines } = setup();
    const result = client.analyze(initialTarget);
    client.dispose();
    await settle();
    expect(await result).toEqual({ status: "cancelled" });
    expect(engines).toHaveLength(0);
  });
});

function clientDispose(client: AnalysisWorkerClient) {
  client.dispose();
}
