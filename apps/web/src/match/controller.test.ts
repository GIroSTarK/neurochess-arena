import {
  type GameDetails,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AiApi, AiRequestFailure } from "../api/ai-client";
import { ApiFailure } from "../api/failures";
import { invocationRecords, telemetryDetails } from "../test/ai-invocations";
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
  it("does not resume or dispatch when saved credentials are selected after recovery", async () => {
    const h = harness();
    await h.controller.load(GAME_ID);
    h.controller.setSaved("white", GAME_ID);
    h.controller.setKey("black", "tab-key");
    expect(h.api.turn).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    h.api.turn.mockResolvedValue(
      snapshot(["e2e4"], { version: 2, state: "paused", legalMoves: [] }),
    );
    await h.controller.continue(true);
    expect(h.api.turn).toHaveBeenCalledWith(
      expect.objectContaining({ step: true }),
      { credentialId: GAME_ID },
      expect.any(AbortSignal),
    );
    window.dispatchEvent(new Event("pagehide"));
    expect(h.controller.getSnapshot().keys).toEqual({ white: false, black: false });
  });
  it("does not restore an earlier provider-pause notice while an explicit retry is in flight", async () => {
    const game = { ...details, snapshot: snapshot([], { state: "paused", legalMoves: [] }) };
    const h = harness(game);
    const records = invocationRecords();
    records.turns = [records.turns[0]!];
    records.turns[0]!.acceptedMovePly = null;
    records.turns[0]!.attempts.pop();
    h.api.invocations.mockImplementation(async () => ({
      ...records,
      version: h.controller.getSnapshot().details!.snapshot.version,
    }));
    await h.controller.load(GAME_ID);
    await h.controller.loadInvocations();
    expect(h.controller.getSnapshot().issue?.kind).toBe("provider");
    h.controller.setKey("white", "white-secret");
    h.controller.setKey("black", "black-secret");
    const pending = Promise.withResolvers<GameSnapshot>();
    h.api.turn.mockReturnValueOnce(pending.promise);
    const sending = h.controller.continue(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot().thinking).toBe(true);
    await h.controller.loadInvocations();
    expect(h.controller.getSnapshot().issue).toBeNull();
    const accepted = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 });
    h.store(accepted);
    pending.resolve(accepted);
    await sending;
  });

  it("refreshes terminal operational records even when the chess revision does not change", async () => {
    const game = {
      ...telemetryDetails,
      snapshot: snapshot(["e2e4", "e7e5"], {
        state: "aborted",
        terminationReason: "aborted",
        legalMoves: [],
      }),
    };
    const h = harness(game);
    const records = invocationRecords();
    h.api.invocations.mockResolvedValue(records);
    await h.controller.load(GAME_ID);
    expect(h.controller.getSnapshot().invocations).toEqual(records);
    const refreshed = structuredClone(records);
    refreshed.turns[1]!.attempts[0]!.durationMs = 900;
    h.api.invocations.mockResolvedValue(refreshed);
    await h.controller.loadInvocations();
    expect(h.controller.getSnapshot().invocations).toEqual(refreshed);
    expect(h.api.turn).not.toHaveBeenCalled();
    expect(h.api.lifecycle).not.toHaveBeenCalled();
  });

  it("discards telemetry returning after leaving a private game", async () => {
    const game = {
      ...telemetryDetails,
      snapshot: snapshot(["e2e4", "e7e5"], {
        state: "aborted",
        terminationReason: "aborted",
        legalMoves: [],
      }),
    };
    const h = harness(game);
    const pending = Promise.withResolvers<Awaited<ReturnType<AiApi["invocations"]>>>();
    h.api.invocations.mockReturnValue(pending.promise);
    await h.controller.load(GAME_ID);
    const signal = h.api.invocations.mock.calls[0]![1];
    h.controller.newGame();
    expect(signal.aborted).toBe(true);
    pending.resolve(invocationRecords());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: "setup",
      invocations: null,
      invocationsLoading: false,
    });
  });

  it("retains received telemetry through new revisions and failed reads, then clears it on leaving", async () => {
    const game = {
      ...telemetryDetails,
      snapshot: snapshot(["e2e4", "e7e5"], { state: "paused", legalMoves: [] }),
    };
    const h = harness(game);
    const records = invocationRecords();
    h.api.invocations.mockImplementation(async () => ({
      ...records,
      version: h.controller.getSnapshot().details!.snapshot.version,
    }));
    await h.controller.load(GAME_ID);
    await vi.advanceTimersByTimeAsync(0);
    const received = h.controller.getSnapshot().invocations;
    expect(received?.turns).toEqual(records.turns);
    const reads: ReturnType<
      typeof Promise.withResolvers<Awaited<ReturnType<AiApi["invocations"]>>>
    >[] = [];
    h.api.invocations.mockImplementation(() => {
      const read = Promise.withResolvers<Awaited<ReturnType<AiApi["invocations"]>>>();
      reads.push(read);
      return read.promise;
    });
    h.controller.setKey("white", "white-secret");
    h.controller.setKey("black", "black-secret");
    h.api.turn.mockImplementationOnce(async () => {
      const accepted = snapshot(["e2e4", "e7e5", "g1f3"], {
        state: "paused",
        legalMoves: [],
        version: h.controller.getSnapshot().details!.snapshot.version + 1,
      });
      h.store(accepted);
      return accepted;
    });
    const observed: (typeof received)[] = [];
    const unsubscribe = h.controller.subscribe(() =>
      observed.push(h.controller.getSnapshot().invocations),
    );
    await h.controller.continue(true);
    expect(h.controller.getSnapshot()).toMatchObject({
      invocations: received,
      invocationsMoveCount: 2,
      invocationsLoading: true,
    });
    reads.at(-1)!.reject(new ApiFailure("network"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toMatchObject({
      invocations: received,
      invocationsMoveCount: 2,
      invocationsError: true,
      invocationsLoading: false,
    });
    expect(observed.every((value) => value === received)).toBe(true);
    unsubscribe();
    const updated = { ...records, version: h.controller.getSnapshot().details!.snapshot.version };
    h.api.invocations.mockResolvedValueOnce(updated);
    await h.controller.loadInvocations();
    expect(h.controller.getSnapshot()).toMatchObject({
      invocations: updated,
      invocationsMoveCount: 3,
      invocationsError: false,
    });
    h.disconnect();
    for (const read of reads) read.resolve(records);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toMatchObject({
      invocations: null,
      invocationsMoveCount: 0,
    });
  });

  it("fences superseded telemetry by revision without blocking inference", async () => {
    const h = harness();
    const pending = Promise.withResolvers<Awaited<ReturnType<AiApi["invocations"]>>>();
    h.api.invocations.mockReturnValueOnce(pending.promise);
    h.api.turn.mockImplementationOnce(async () => {
      const accepted = snapshot(["e2e4"]);
      h.store(accepted);
      return accepted;
    });
    h.keys();
    await h.controller.created(details);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    pending.resolve({ gameId: GAME_ID, version: 0, turns: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot().invocations?.version).toBe(1);
    expect(h.api.invocations.mock.calls[0]![1].aborted).toBe(true);
  });

  it("synchronizes a passive game when telemetry reports a newer server revision", async () => {
    const h = harness();
    await h.controller.load(GAME_ID);
    await vi.advanceTimersByTimeAsync(0);
    const cached = h.controller.getSnapshot();
    const latest = snapshot(["e2e4"], { version: cached.details!.snapshot.version + 2 });
    const pending = Promise.withResolvers<GameSnapshot>();
    h.store(latest);
    h.api.snapshot.mockReturnValueOnce(pending.promise);
    h.api.snapshot.mockClear();
    h.api.lifecycle.mockClear();
    const reads = h.api.invocations.mock.calls.length;

    await vi.advanceTimersByTimeAsync(3000);
    expect(h.api.snapshot).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot()).toMatchObject({
      details: cached.details,
      invocations: cached.invocations,
      invocationsMoveCount: 0,
      invocationsLoading: true,
      invocationsError: false,
    });
    const signal = h.api.invocations.mock.calls.at(-1)![1];
    pending.resolve(latest);
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    expect(h.api.invocations).toHaveBeenCalledTimes(reads + 2);
    expect(h.controller.getSnapshot()).toMatchObject({
      details: { snapshot: latest },
      invocations: { gameId: GAME_ID, version: latest.version },
      invocationsMoveCount: 1,
      invocationsLoading: false,
      invocationsError: false,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.api.invocations).toHaveBeenCalledTimes(reads + 3);
    expect(h.controller.getSnapshot().invocationsError).toBe(false);
    expect(h.api.controller).not.toHaveBeenCalled();
    expect(h.api.turn).not.toHaveBeenCalled();
    expect(h.api.lifecycle).not.toHaveBeenCalled();
  });

  it("retries telemetry synchronization after a failed snapshot read", async () => {
    const h = harness();
    await h.controller.load(GAME_ID);
    await vi.advanceTimersByTimeAsync(0);
    const cached = h.controller.getSnapshot();
    const latest = snapshot(["e2e4"], { version: cached.details!.snapshot.version + 2 });
    h.store(latest);
    h.api.snapshot.mockRejectedValueOnce(new ApiFailure("network"));

    await vi.advanceTimersByTimeAsync(3000);
    expect(h.controller.getSnapshot()).toMatchObject({
      details: cached.details,
      invocations: cached.invocations,
      invocationsLoading: false,
      invocationsError: true,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.controller.getSnapshot()).toMatchObject({
      details: { snapshot: latest },
      invocations: { version: latest.version },
      invocationsMoveCount: 1,
      invocationsLoading: false,
      invocationsError: false,
    });
  });

  it("discards telemetry synchronization returning after the page lifetime ends", async () => {
    const h = harness();
    await h.controller.load(GAME_ID);
    await vi.advanceTimersByTimeAsync(0);
    const latest = snapshot(["e2e4"], {
      version: h.controller.getSnapshot().details!.snapshot.version + 2,
    });
    const pending = Promise.withResolvers<GameSnapshot>();
    h.store(latest);
    h.api.snapshot.mockReturnValueOnce(pending.promise);
    h.api.snapshot.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.api.snapshot).toHaveBeenCalledTimes(1);
    const signal = h.api.snapshot.mock.calls.at(-1)![1];

    window.dispatchEvent(new Event("pagehide"));
    expect(signal.aborted).toBe(true);
    pending.resolve(latest);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: "loading",
      details: null,
      invocations: null,
      invocationsLoading: false,
      invocationsError: false,
    });
  });

  it("discards a telemetry synchronization superseded by explicit recovery", async () => {
    const h = harness();
    await h.controller.load(GAME_ID);
    await vi.advanceTimersByTimeAsync(0);
    const latest = snapshot(["e2e4"], {
      version: h.controller.getSnapshot().details!.snapshot.version + 2,
    });
    const pending = Promise.withResolvers<GameSnapshot>();
    h.store(latest);
    h.api.snapshot.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(3000);
    const signal = h.api.snapshot.mock.calls.at(-1)![1];

    await h.controller.recover();
    await vi.advanceTimersByTimeAsync(0);
    const recovered = h.controller.getSnapshot();
    expect(signal.aborted).toBe(true);
    expect(recovered.details!.snapshot.version).toBe(latest.version + 1);
    const reads = h.api.invocations.mock.calls.length;
    pending.resolve(snapshot(["e2e4", "e7e5"], { version: latest.version + 2 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toEqual(recovered);
    expect(h.api.invocations).toHaveBeenCalledTimes(reads);
  });

  it("rejects telemetry older than the accepted snapshot without synchronizing", async () => {
    const h = harness();
    await h.controller.load(GAME_ID);
    await vi.advanceTimersByTimeAsync(0);
    const cached = h.controller.getSnapshot();
    h.api.snapshot.mockClear();
    h.api.invocations.mockResolvedValueOnce({
      gameId: GAME_ID,
      version: cached.details!.snapshot.version - 1,
      turns: [],
    });

    await h.controller.loadInvocations();
    expect(h.api.snapshot).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({
      details: cached.details,
      invocations: cached.invocations,
      invocationsLoading: false,
      invocationsError: true,
    });
  });

  it("polls same-revision records on human turns and handles telemetry errors independently", async () => {
    const game = humanGame("white");
    const h = harness(game);
    h.keys();
    await h.controller.created(game);
    const reads = h.api.invocations.mock.calls.length;
    h.api.invocations.mockRejectedValueOnce(new ApiFailure("network"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.api.invocations.mock.calls.length).toBeGreaterThan(reads);
    expect(h.controller.getSnapshot().invocationsError).toBe(true);
    expect(h.controller.canMove()).toBe(true);
    await h.controller.loadInvocations();
    expect(h.controller.getSnapshot().invocationsError).toBe(false);
    h.api.invocations.mockResolvedValueOnce({ gameId: crypto.randomUUID(), version: 0, turns: [] });
    await h.controller.loadInvocations();
    expect(h.controller.getSnapshot()).toMatchObject({
      invocations: { gameId: GAME_ID, version: 0, turns: [] },
      invocationsError: true,
    });
    h.api.invocations.mockRejectedValueOnce(new ApiFailure("api", "NOT_FOUND"));
    await h.controller.loadInvocations();
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: "unavailable",
      details: null,
      invocations: null,
    });
    expect(h.controller.credentials).toBeNull();
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  function humanGame(color: "white" | "black"): GameDetails {
    return {
      ...details,
      configuration: {
        mode: "ai_vs_human",
        seats:
          color === "white"
            ? { white: { type: "human" }, black: seat }
            : { white: seat, black: { type: "human" } },
      },
    };
  }

  it.each(["white", "black"] as const)(
    "coordinates the %s human, blocks duplicate commands, and waits on human turns",
    async (color) => {
      const game = humanGame(color);
      const h = harness(game);
      h.controller.credentials?.set(color === "white" ? "black" : "white", "openai", "only-ai-key");
      const moves = color === "white" ? [] : ["f2f3"];
      h.api.turn.mockImplementation(async () => {
        const next = snapshot([...moves]);
        h.store(next);
        return next;
      });
      await h.controller.created(game);
      expect(h.api.turn).toHaveBeenCalledTimes(color === "white" ? 0 : 1);
      expect(h.controller.canMove()).toBe(true);
      await vi.advanceTimersByTimeAsync(6000);
      expect(h.api.turn).toHaveBeenCalledTimes(color === "white" ? 0 : 1);
      const humanMove = color === "white" ? "f2f3" : "e7e5";
      const pending = Promise.withResolvers<GameSnapshot>();
      h.api.move.mockReturnValueOnce(pending.promise);
      const sending = h.controller.move(humanMove);
      await h.controller.move(humanMove);
      expect(h.api.move).toHaveBeenCalledTimes(1);
      expect(h.controller.canMove()).toBe(false);
      expect(h.controller.getSnapshot().details?.snapshot.moves).toHaveLength(moves.length);
      moves.push(humanMove);
      h.store(snapshot(moves));
      pending.resolve(snapshot(moves));
      await sending;
      moves.push(color === "white" ? "e7e5" : "g2g4");
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.api.turn).toHaveBeenCalledTimes(color === "white" ? 1 : 2);
      expect(h.controller.canMove()).toBe(true);
      await vi.advanceTimersByTimeAsync(6000);
      expect(h.api.turn).toHaveBeenCalledTimes(color === "white" ? 1 : 2);
    },
  );

  it("keeps an uncertain human command and retries its exact identity before paused recovery", async () => {
    const game = humanGame("white");
    const h = harness(game);
    h.keys();
    await h.controller.created(game);
    h.api.move.mockRejectedValueOnce(new ApiFailure("network"));
    await h.controller.move("e2e4");
    expect(h.api.snapshot).toHaveBeenCalled();
    expect(h.controller.hasPendingMove()).toBe(true);
    expect(h.controller.canMove()).toBe(false);
    await h.controller.move("d2d4");
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.api.turn).not.toHaveBeenCalled();
    h.api.move.mockImplementationOnce(async () => {
      const accepted = snapshot(["e2e4"]);
      h.store(accepted);
      return accepted;
    });
    await h.controller.retryMove();
    expect(h.api.move.mock.calls[1]?.[0]).toEqual(h.api.move.mock.calls[0]?.[0]);
    expect(h.controller.hasPendingMove()).toBe(false);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  it("adopts a committed human move after a lost acknowledgement without repeating or dispatching AI", async () => {
    const game = humanGame("white");
    const h = harness(game);
    h.keys();
    await h.controller.created(game);
    h.api.move.mockImplementationOnce(async () => {
      h.store(snapshot(["e2e4"]));
      throw new ApiFailure("malformed");
    });
    await h.controller.move("e2e4");
    expect(h.controller.getSnapshot().details?.snapshot.moves).toHaveLength(1);
    expect(h.controller.hasPendingMove()).toBe(false);
    expect(h.controller.canMove()).toBe(false);
    expect(h.api.turn).not.toHaveBeenCalled();
    await h.controller.recover();
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
  });

  it("requires only the AI key after human-turn recovery and never steps a human seat", async () => {
    window.history.replaceState(null, "", "/?game=" + GAME_ID);
    const h = harness(humanGame("white"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    await h.controller.continue(false);
    expect(h.api.controller).not.toHaveBeenCalled();
    h.controller.setKey("black", "ai-key");
    await h.controller.continue(true);
    expect(h.api.controller).not.toHaveBeenCalled();
    await h.controller.continue(false);
    expect(h.controller.canMove()).toBe(true);
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  it("derives resignation from the human seat and does not repeat it after a conflicting revision", async () => {
    const h = harness(humanGame("black"));
    h.keys();
    h.api.turn.mockReturnValue(new Promise(() => undefined));
    void h.controller.created(humanGame("black"));
    await vi.advanceTimersByTimeAsync(0);
    h.api.lifecycle.mockRejectedValueOnce(
      new ApiFailure("api", "GAME_CONFLICT", snapshot(["e2e4"])),
    );
    await h.controller.lifecycle("resign");
    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
    expect(h.api.lifecycle.mock.calls[0]?.[0]).toMatchObject({
      action: "resign",
      losingColor: "black",
    });
    expect(h.controller.getSnapshot().phase).toBe("uncertain");
  });

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
