import {
  type GameDetails,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AiApi, AiRequestFailure } from "../api/ai-client";
import { ApiFailure } from "../api/failures";
import { GAME_ID, snapshot } from "../test/fixtures";

import { MatchController } from "./controller";

const seat = { type: "ai", provider: "openai", modelId: "fixture", parameters: {} } as const;
const details: GameDetails = {
  snapshot: snapshot(),
  configuration: { mode: "ai_vs_ai", seats: { white: seat, black: seat } },
};

function harness(initial = details) {
  let stored = initial.snapshot;
  const api = {
    bootstrap: vi.fn<AiApi["bootstrap"]>(),
    discover: vi.fn<AiApi["discover"]>(),
    create: vi.fn<AiApi["create"]>(),
    details: vi.fn<AiApi["details"]>(async () => ({ ...initial, snapshot: stored })),
    snapshot: vi.fn<AiApi["snapshot"]>(async () => stored),
    controller: vi.fn<AiApi["controller"]>(async () => stored),
    unfinished: vi.fn<AiApi["unfinished"]>(async () => null),
    move: vi.fn<AiApi["move"]>(),
    invocations: vi.fn<AiApi["invocations"]>(async () => ({
      gameId: GAME_ID,
      version: stored.version,
      turns: [],
    })),
    turn: vi.fn<AiApi["turn"]>(),
    lifecycle: vi.fn<AiApi["lifecycle"]>(async (command) => {
      if (command.expectedVersion !== stored.version) {
        throw new ApiFailure("api", "GAME_CONFLICT", stored);
      }
      const state =
        command.action === "resume" ? "active" : command.action === "abort" ? "aborted" : "paused";
      stored = gameSnapshotSchema.parse({
        ...stored,
        version: stored.version + 1,
        state,
        legalMoves:
          state === "active" ? snapshot(stored.moves.map(({ uci }) => uci)).legalMoves : [],
        terminationReason: state === "aborted" ? "aborted" : null,
      });
      return stored;
    }),
    replay: vi.fn<AiApi["replay"]>(async () =>
      gameReplayResponseSchema.parse({ snapshot: stored, initialFen: snapshot().fen }),
    ),
    pgn: vi.fn<AiApi["pgn"]>(),
  } satisfies AiApi;
  const controller = new MatchController(api);
  const disconnect = controller.connect();
  cleanups.push(disconnect);
  const keys = () => {
    for (const color of ["white", "black"] as const) {
      controller.credentials?.set(color, "openai", `${color}-secret-sentinel`);
    }
  };
  return {
    api,
    controller,
    keys,
    disconnect,
    store: (next: GameSnapshot) => {
      stored = next;
    },
  };
}

let cleanups: (() => void)[];
beforeEach(() => {
  cleanups = [];
  window.history.replaceState(null, "", "/");
  vi.useFakeTimers();
});
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

describe("page-owned Arena orchestration", () => {
  it("serializes turns and measures speed from the complete accepted response", async () => {
    const h = harness();
    h.keys();
    const first = Promise.withResolvers<GameSnapshot>();
    h.api.turn.mockReturnValueOnce(first.promise).mockReturnValue(new Promise(() => undefined));
    const starting = h.controller.created(details);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    await h.controller.continue(false);
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().details?.snapshot).toEqual(details.snapshot);
    const accepted = snapshot(["e2e4"]);
    h.store(accepted);
    first.resolve(accepted);
    await starting;
    await vi.advanceTimersByTimeAsync(1499);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.api.turn).toHaveBeenCalledTimes(2);
    expect(h.api.turn.mock.calls[1]?.[0].expectedVersion).toBe(1);
    expect(JSON.stringify(h.controller.getSnapshot())).not.toContain("secret-sentinel");
  });

  it.each(["pause", "abort"] as const)(
    "allows %s during inference and ignores its obsolete acknowledgement",
    async (action) => {
      const h = harness();
      h.keys();
      const pending = Promise.withResolvers<GameSnapshot>();
      h.api.turn.mockReturnValue(pending.promise);
      const starting = h.controller.created(details);
      await vi.advanceTimersByTimeAsync(0);
      await h.controller.lifecycle(action);
      const final = h.controller.getSnapshot().details?.snapshot;
      expect(final?.state).toBe(action === "pause" ? "paused" : "aborted");
      pending.resolve(snapshot(["e2e4"]));
      await starting;
      await vi.advanceTimersByTimeAsync(6000);
      expect(h.controller.getSnapshot().details?.snapshot).toEqual(final);
      expect(h.api.turn).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks uncertain inference and resolves it through read plus an explicit versioned pause", async () => {
    const h = harness();
    h.keys();
    h.api.turn.mockRejectedValue(new ApiFailure("malformed"));
    await h.controller.created(details);
    expect(h.controller.getSnapshot().phase).toBe("uncertain");
    await vi.advanceTimersByTimeAsync(6000);
    await h.controller.continue(false);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    await h.controller.recover();
    expect(h.api.lifecycle.mock.calls[0]?.[0]).toMatchObject({
      expectedVersion: 0,
      action: "pause",
    });
    expect(h.api.lifecycle.mock.calls[0]?.[0]).not.toHaveProperty("controllerId");
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    expect(h.api.turn).toHaveBeenCalledTimes(1);
  });

  it("retains an uncertain Pause identity and then revokes the old lease during recovery", async () => {
    const h = harness();
    h.keys();
    h.api.turn.mockReturnValue(new Promise(() => undefined));
    void h.controller.created(details);
    await vi.advanceTimersByTimeAsync(0);
    const normal = h.api.lifecycle.getMockImplementation()!;
    h.api.lifecycle.mockRejectedValueOnce(new ApiFailure("timeout"));
    await h.controller.lifecycle("pause");
    const original = h.api.lifecycle.mock.calls[0]?.[0];
    expect(original).toHaveProperty("controllerId");
    h.api.lifecycle.mockImplementation(normal);
    await h.controller.recover();
    expect(h.api.lifecycle.mock.calls[1]?.[0]).toEqual(original);
    expect(h.api.lifecycle.mock.calls[2]?.[0]).toMatchObject({
      expectedVersion: 1,
      action: "pause",
    });
    expect(h.api.lifecycle.mock.calls[2]?.[0]).not.toHaveProperty("controllerId");
    expect(h.controller.getSnapshot().phase).toBe("ready");
    expect(h.controller.getSnapshot().details?.snapshot.version).toBe(2);
  });

  it("recovers on refresh, blocks missing keys, and only steps after explicit action", async () => {
    window.history.replaceState(null, "", "/?game=" + GAME_ID);
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    expect(h.api.controller).not.toHaveBeenCalled();
    await h.controller.continue(false);
    expect(h.api.turn).not.toHaveBeenCalled();
    h.controller.setKey("white", "white-secret-sentinel");
    await h.controller.continue(true);
    expect(h.api.turn).not.toHaveBeenCalled();
    h.controller.setKey("black", "black-secret-sentinel");
    expect(h.api.turn).not.toHaveBeenCalled();
    h.api.turn.mockResolvedValue(
      snapshot(["e2e4"], { state: "paused", version: 2, legalMoves: [] }),
    );
    await h.controller.continue(true);
    expect(h.api.turn.mock.calls[0]?.[0]).toMatchObject({ step: true, expectedVersion: 1 });
    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
  });

  it("halts on heartbeat failure and clears keys and pending requests on pagehide", async () => {
    const h = harness();
    h.keys();
    h.api.turn.mockReturnValue(new Promise(() => undefined));
    void h.controller.created(details);
    await vi.advanceTimersByTimeAsync(0);
    h.api.controller.mockRejectedValue(new AiRequestFailure("AI_CONTROLLER_LOST"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.controller.getSnapshot().phase).toBe("uncertain");
    const signal = h.api.turn.mock.calls[0]?.[2];
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(signal?.aborted).toBe(true);
    expect(h.controller.credentials).toBeNull();
    expect(h.controller.getSnapshot().details).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
  });

  it("access loss clears private state without a replacement guest bootstrap", async () => {
    window.history.replaceState(null, "", "/?game=" + GAME_ID);
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.api.lifecycle.mockRejectedValue(new ApiFailure("api", "UNAUTHORIZED"));
    await h.controller.lifecycle("abort");
    expect(h.controller.getSnapshot()).toMatchObject({
      details: null,
      phase: "unavailable",
      replay: null,
      exportText: null,
    });
    expect(h.controller.credentials).toBeNull();
    expect(h.api.bootstrap).not.toHaveBeenCalled();
  });
});
