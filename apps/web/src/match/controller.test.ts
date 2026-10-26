import type { GameDetails, GameSnapshot } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AiApi, AiRequestFailure } from "../api/ai-client";
import { ApiFailure } from "../api/failures";
import type { PgnDelivery } from "../gameplay/pgn";
import { invocationRecords, telemetryDetails } from "../test/ai-invocations";
import { FOOLS_MATE, GAME_ID, OTHER_GAME_ID, snapshot } from "../test/fixtures";
import { createMatchApiFixture } from "../test/match-api";

import { MatchController } from "./controller";

const seat = { type: "ai", provider: "openai", modelId: "fixture", parameters: {} } as const;
const details: GameDetails = {
  snapshot: snapshot(),
  configuration: { mode: "ai_vs_ai", seats: { white: seat, black: seat } },
};

function harness(initial = details, delivery?: PgnDelivery, enterSetup = true) {
  const { api, readSnapshot, seedSnapshot } = createMatchApiFixture(initial);
  const navigation = { game: vi.fn(), setup: vi.fn() };
  const controller = new MatchController(api, delivery, navigation);
  if (enterSetup) void controller.enter({ kind: "setup" });
  const disconnect = () => controller.endLifetime();
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
    navigation,
    enter: () =>
      controller.enter({
        kind: "game",
        gameId: readSnapshot().gameId,
        details: { ...initial, snapshot: readSnapshot() },
      }),
    store: seedSnapshot,
  };
}

let cleanups: (() => void)[];
beforeEach(() => {
  cleanups = [];
  vi.useFakeTimers();
});
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

describe("page-owned Arena orchestration", () => {
  it("recovers a non-default game and loads telemetry for its accepted revision", async () => {
    const initial = {
      ...details,
      snapshot: snapshot(["e2e4"], { gameId: OTHER_GAME_ID, version: 7 }),
    };
    const h = harness(initial);
    await h.enter();

    expect(h.controller.getSnapshot()).toMatchObject({
      phase: "ready",
      details: {
        ...initial,
        snapshot: { ...initial.snapshot, state: "paused", version: 8, legalMoves: [] },
      },
      invocations: { gameId: OTHER_GAME_ID, version: 8, turns: [] },
      invocationsError: false,
    });
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  it("constructs an idle graph and opens credentials only on explicit entry", async () => {
    const delivery = { copy: vi.fn().mockResolvedValue(true), download: vi.fn() };
    const h = harness(details, delivery, false);
    expect(h.controller.credentials).toBeNull();
    expect(h.controller.getSnapshot().details).toBeNull();

    await h.controller.created(details);
    h.controller.endLifetime();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.controller.credentials).toBeNull();
    for (const request of Object.values(h.api)) expect(request).not.toHaveBeenCalled();
    expect(h.navigation.game).not.toHaveBeenCalled();
    expect(h.navigation.setup).not.toHaveBeenCalled();
    expect(delivery.copy).not.toHaveBeenCalled();
    expect(delivery.download).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await h.controller.enter({ kind: "setup" });
    const credentials = h.controller.credentials!;
    expect(credentials.signal.aborted).toBe(false);
    h.controller.endLifetime();
    expect(credentials.signal.aborted).toBe(true);
    expect(h.controller.credentials).toBeNull();
  });

  it("publishes move and control availability with the state observed by subscribers", async () => {
    const game = humanGame("white");
    const h = harness(game);
    h.keys();
    const observed: ReturnType<MatchController["getSnapshot"]>[] = [];
    h.controller.subscribe(() => observed.push(h.controller.getSnapshot()));
    await h.controller.created(game);
    expect(observed.at(-1)).toMatchObject({
      canMove: true,
      pendingMove: false,
      pendingControl: false,
    });

    const move = Promise.withResolvers<GameSnapshot>();
    h.api.move.mockReturnValueOnce(move.promise);
    const moving = h.controller.move("e2e4");
    expect(observed.at(-1)).toMatchObject({ busy: true, canMove: false, pendingMove: true });
    h.store(snapshot(["e2e4"]));
    move.resolve(snapshot(["e2e4"]));
    await moving;
    expect(observed.at(-1)).toMatchObject({ busy: false, canMove: false, pendingMove: false });

    const pause = Promise.withResolvers<GameSnapshot>();
    h.api.lifecycle.mockReturnValueOnce(pause.promise);
    const pausing = h.controller.lifecycle("pause");
    expect(observed.at(-1)).toMatchObject({ busy: true, pendingControl: true, canMove: false });
    pause.reject(new ApiFailure("timeout"));
    await pausing;
    expect(observed.at(-1)).toMatchObject({
      phase: "uncertain",
      busy: false,
      pendingControl: true,
      canMove: false,
    });
    await h.controller.retryControl();
    expect(observed.at(-1)).toMatchObject({
      phase: "ready",
      pendingControl: false,
      canMove: false,
    });

    h.disconnect();
    expect(observed.at(-1)).toMatchObject({
      details: null,
      pendingMove: false,
      pendingControl: false,
      canMove: false,
    });
  });

  it.each(["UNAUTHORIZED", "PROFILE_REQUIRED", "FORBIDDEN", "NOT_FOUND"] as const)(
    "clears both archive slots on %s and prevents late PGN delivery",
    async (code) => {
      const initial = { ...details, snapshot: snapshot(FOOLS_MATE) };
      const delivery = { copy: vi.fn().mockResolvedValue(true), download: vi.fn() };
      const h = harness(initial, delivery);
      const replay = Promise.withResolvers<Awaited<ReturnType<AiApi["replay"]>>>();
      const pgn = Promise.withResolvers<Awaited<ReturnType<AiApi["pgn"]>>>();
      h.api.replay.mockReturnValueOnce(replay.promise);
      h.api.pgn.mockReturnValueOnce(pgn.promise);
      const entering = h.enter();
      await vi.advanceTimersByTimeAsync(0);
      const exporting = h.controller.exportPgn("download");
      await h.controller.loadReplay();
      await h.controller.exportPgn("copy");
      expect(h.api.replay).toHaveBeenCalledTimes(1);
      expect(h.api.pgn).toHaveBeenCalledTimes(1);

      replay.reject(new ApiFailure("api", code));
      await entering;
      expect(h.api.pgn.mock.calls[0]?.[1].aborted).toBe(true);
      expect(h.controller.getSnapshot()).toMatchObject({
        phase: "unavailable",
        details: null,
        replay: null,
        exportText: null,
        exportResult: null,
        issue: { kind: "notice", code: "access" },
      });
      pgn.resolve({
        gameId: GAME_ID,
        version: initial.snapshot.version,
        pgn: initial.snapshot.pgn,
      });
      await exporting;
      expect(delivery.download).not.toHaveBeenCalled();
      expect(h.controller.getSnapshot().details).toBeNull();
      expect(h.api.bootstrap).not.toHaveBeenCalled();
    },
  );

  it.each(["replay", "export"] as const)(
    "fences an obsolete %s access failure when telemetry adopts a newer revision",
    async (slot) => {
      const initial = { ...details, snapshot: snapshot(FOOLS_MATE) };
      const h = harness(initial);
      const replay = Promise.withResolvers<Awaited<ReturnType<AiApi["replay"]>>>();
      const pgn = Promise.withResolvers<Awaited<ReturnType<AiApi["pgn"]>>>();
      if (slot === "replay") h.api.replay.mockReturnValueOnce(replay.promise);
      else h.api.pgn.mockReturnValueOnce(pgn.promise);
      const entering = h.enter();
      await vi.advanceTimersByTimeAsync(0);
      const obsolete = slot === "replay" ? entering : h.controller.exportPgn("copy");
      const signal =
        slot === "replay" ? h.api.replay.mock.calls[0]?.[1] : h.api.pgn.mock.calls[0]?.[1];
      const next = { ...initial.snapshot, version: initial.snapshot.version + 1 };
      h.store(next);
      await h.controller.loadInvocations();
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(true);
      expect(h.controller.getSnapshot()).toMatchObject({
        details: { snapshot: next },
        replay: { snapshot: next },
        replayError: false,
        exportResult: null,
      });
      (slot === "replay" ? replay : pgn).reject(new ApiFailure("api", "FORBIDDEN"));
      await obsolete;
      expect(h.controller.getSnapshot()).toMatchObject({
        phase: "ready",
        details: { snapshot: next },
        replay: { snapshot: next },
        replayError: false,
        exportResult: null,
      });
    },
  );

  it("keeps a new export pending when an earlier lifetime's request fails", async () => {
    const initial = { ...details, snapshot: snapshot(FOOLS_MATE) };
    const delivery = { copy: vi.fn().mockResolvedValue(false), download: vi.fn() };
    const h = harness(initial, delivery);
    await h.enter();
    const old = Promise.withResolvers<Awaited<ReturnType<AiApi["pgn"]>>>();
    const current = Promise.withResolvers<Awaited<ReturnType<AiApi["pgn"]>>>();
    h.api.pgn.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = h.controller.exportPgn("copy");
    h.disconnect();
    expect(h.api.pgn.mock.calls[0]?.[1].aborted).toBe(true);
    await h.enter();
    const retry = h.controller.exportPgn("copy");
    old.reject(new ApiFailure("api", "NOT_FOUND"));
    await first;
    expect(h.controller.getSnapshot()).toMatchObject({ exportBusy: true, exportResult: null });
    await h.controller.exportPgn("copy");
    expect(h.api.pgn).toHaveBeenCalledTimes(2);
    current.resolve({
      gameId: GAME_ID,
      version: initial.snapshot.version,
      pgn: initial.snapshot.pgn,
    });
    await retry;
    expect(h.controller.getSnapshot()).toMatchObject({
      exportBusy: false,
      exportResult: "manual",
      exportText: initial.snapshot.pgn,
    });
    expect(delivery.copy).toHaveBeenCalledExactlyOnceWith(initial.snapshot.pgn);
  });

  it("does not restore manual PGN text when clipboard completion arrives after departure", async () => {
    const initial = { ...details, snapshot: snapshot(FOOLS_MATE) };
    const clipboard = Promise.withResolvers<boolean>();
    const delivery = { copy: vi.fn(() => clipboard.promise), download: vi.fn() };
    const h = harness(initial, delivery);
    await h.enter();
    h.api.pgn.mockResolvedValueOnce({
      gameId: GAME_ID,
      version: initial.snapshot.version,
      pgn: initial.snapshot.pgn,
    });
    const exporting = h.controller.exportPgn("copy");
    await vi.advanceTimersByTimeAsync(0);
    expect(delivery.copy).toHaveBeenCalledOnce();
    h.disconnect();
    await h.enter();
    clipboard.resolve(false);
    await exporting;
    expect(h.controller.getSnapshot()).toMatchObject({ exportResult: null, exportText: null });
  });

  it.each(["turn", "invocations"] as const)(
    "ends private gameplay on PROFILE_REQUIRED from %s and fences late responses",
    async (source) => {
      const h = harness();
      h.keys();
      const credentials = h.controller.credentials!;
      const pending = Promise.withResolvers<GameSnapshot>();
      h.api.turn.mockReturnValueOnce(pending.promise);
      const starting = h.controller.created(details);
      await vi.advanceTimersByTimeAsync(0);
      const signal = h.api.turn.mock.calls[0]![2];
      const failure = new ApiFailure("api", "PROFILE_REQUIRED");
      if (source === "turn") {
        pending.reject(failure);
        await starting;
      } else {
        h.api.invocations.mockRejectedValueOnce(failure);
        await h.controller.loadInvocations();
      }

      const stopped = h.controller.getSnapshot();
      expect(stopped).toMatchObject({
        phase: "unavailable",
        issue: { kind: "notice", code: "access" },
        details: null,
        invocations: null,
        replay: null,
        exportText: null,
        keys: { white: false, black: false },
        thinking: false,
        busy: false,
      });
      expect(signal.aborted).toBe(true);
      expect(h.controller.credentials).toBeNull();
      expect(() => credentials.require("white", "openai")).toThrow();
      expect(() => credentials.require("black", "openai")).toThrow();
      const reads = h.api.invocations.mock.calls.length;
      const presence = h.api.controller.mock.calls.length;
      if (source === "invocations") pending.resolve(snapshot(["e2e4"]));
      await starting;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.controller.getSnapshot()).toBe(stopped);
      expect(h.api.turn).toHaveBeenCalledTimes(1);
      expect(h.api.invocations).toHaveBeenCalledTimes(reads);
      expect(h.api.controller).toHaveBeenCalledTimes(presence);
    },
  );

  it("does not dispatch obsolete seeded recovery during a StrictMode reconnect", async () => {
    const h = harness();
    const entry = { kind: "game" as const, gameId: GAME_ID, details };
    void h.controller.enter(entry);
    h.controller.endLifetime();
    void h.controller.enter(entry);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    expect(h.api.details).not.toHaveBeenCalled();
  });

  it("accepts entry details without repeating the read and recovers at the supplied revision", async () => {
    const h = harness();
    await h.controller.enter({ kind: "game", gameId: GAME_ID, details });
    expect(h.api.details).not.toHaveBeenCalled();
    expect(h.api.snapshot).not.toHaveBeenCalled();
    expect(h.api.lifecycle.mock.calls[0]?.[0]).toMatchObject({
      action: "pause",
      expectedVersion: 0,
    });
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    expect(h.controller.getSnapshot().keys).toEqual({ white: false, black: false });
  });

  it("ends a lifetime immediately and idempotently, fencing an ignored turn cancellation", async () => {
    const h = harness();
    h.keys();
    const credentials = h.controller.credentials!;
    const pending = Promise.withResolvers<GameSnapshot>();
    h.api.turn.mockReturnValue(pending.promise);
    const starting = h.controller.created(details);
    await vi.advanceTimersByTimeAsync(0);
    const signal = h.api.turn.mock.calls[0]![2];
    h.controller.endLifetime();
    const stopped = h.controller.getSnapshot();
    h.controller.endLifetime();
    expect(h.controller.getSnapshot()).toBe(stopped);
    expect(signal.aborted).toBe(true);
    expect(() => credentials.require("white", "openai")).toThrow();
    pending.resolve(snapshot(["e2e4"]));
    await starting;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.controller.getSnapshot()).toBe(stopped);
    expect(stopped.details).toBeNull();
    expect(h.api.turn).toHaveBeenCalledTimes(1);
    expect(h.api.controller).toHaveBeenCalledTimes(1);
  });

  it("fences an old recovery response after committing entry data for another game", async () => {
    const h = harness();
    const late = Promise.withResolvers<GameSnapshot>();
    h.api.lifecycle.mockReturnValueOnce(late.promise);
    const other = snapshot([], { gameId: OTHER_GAME_ID });
    const opening = h.controller.enter({
      kind: "game",
      gameId: OTHER_GAME_ID,
      details: { ...details, snapshot: other },
    });
    await vi.advanceTimersByTimeAsync(0);
    const signal = h.api.lifecycle.mock.calls[0]![1];
    await h.controller.enter({ kind: "game", gameId: GAME_ID, details });
    expect(signal.aborted).toBe(true);
    late.resolve(
      snapshot([], { gameId: OTHER_GAME_ID, state: "paused", legalMoves: [], version: 1 }),
    );
    await opening;
    expect(h.controller.getSnapshot().details?.snapshot.gameId).toBe(GAME_ID);
    expect(h.api.lifecycle).toHaveBeenCalledTimes(2);
  });

  it("keeps setup credentials through a creation callback without reading or recovering the game", async () => {
    const h = harness(humanGame("white"));
    const credentials = h.controller.credentials;
    h.keys();
    await h.controller.created(humanGame("white"));
    expect(h.navigation.game).toHaveBeenCalledWith(GAME_ID, "created");
    expect(h.controller.credentials).toBe(credentials);
    expect(h.controller.getSnapshot().keys.black).toBe(true);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("active");
    expect(h.api.details).not.toHaveBeenCalled();
    expect(h.api.snapshot).not.toHaveBeenCalled();
    expect(h.api.lifecycle).not.toHaveBeenCalled();
    h.controller.endLifetime();
    void h.controller.enter({ kind: "game", gameId: GAME_ID, details: humanGame("white") });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    expect(h.controller.getSnapshot().keys.black).toBe(false);
  });

  it("rejects malformed targets and mismatched entry data before private reads or recovery", async () => {
    const h = harness();
    await h.controller.enter({ kind: "game", gameId: "../private", details });
    expect(h.controller.getSnapshot().phase).toBe("unavailable");
    await h.controller.enter({ kind: "game", gameId: OTHER_GAME_ID, details });
    expect(h.controller.getSnapshot().details).toBeNull();
    expect(h.api.details).not.toHaveBeenCalled();
    expect(h.api.lifecycle).not.toHaveBeenCalled();
  });

  it("requires explicit saved selection after recovery and dispatches only on Next move", async () => {
    const h = harness();
    await h.enter();
    const saved = {
      credentialId: GAME_ID,
      provider: "openai" as const,
      label: "Saved",
      maskedSuffix: "1234",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    h.controller.setCredential("white", GAME_ID, [saved]);
    h.controller.setCredential("black", GAME_ID, [saved]);
    expect(h.controller.getSnapshot().keys).toEqual({ white: true, black: true });
    expect(h.api.turn).not.toHaveBeenCalled();
    h.api.turn.mockResolvedValue(snapshot(["e2e4"], { state: "paused", legalMoves: [] }));
    await h.controller.step();
    expect(h.api.turn.mock.calls[0]?.[1]).toEqual({ credentialId: GAME_ID });
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    h.controller.endLifetime();
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
    await h.enter();
    await h.controller.loadInvocations();
    expect(h.controller.getSnapshot().issue?.kind).toBe("provider");
    h.controller.setKey("white", "white-secret");
    h.controller.setKey("black", "black-secret");
    const pending = Promise.withResolvers<GameSnapshot>();
    h.api.turn.mockReturnValueOnce(pending.promise);
    const sending = h.controller.step();
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
    await h.enter();
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
    await h.enter();
    const signal = h.api.invocations.mock.calls[0]![1];
    h.controller.newGame();
    expect(h.navigation.setup).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    pending.resolve(invocationRecords());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: "loading",
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
    await h.enter();
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
    await h.controller.step();
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
    await h.enter();
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
    await h.enter();
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
    await h.enter();
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

    h.controller.endLifetime();
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
    await h.enter();
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
    await h.enter();
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
    expect(h.controller.getSnapshot().canMove).toBe(true);
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
      expect(h.controller.getSnapshot().canMove).toBe(true);
      await vi.advanceTimersByTimeAsync(6000);
      expect(h.api.turn).toHaveBeenCalledTimes(color === "white" ? 0 : 1);
      const humanMove = color === "white" ? "f2f3" : "e7e5";
      const pending = Promise.withResolvers<GameSnapshot>();
      h.api.move.mockReturnValueOnce(pending.promise);
      const sending = h.controller.move(humanMove);
      await h.controller.move(humanMove);
      expect(h.api.move).toHaveBeenCalledTimes(1);
      expect(h.controller.getSnapshot().canMove).toBe(false);
      expect(h.controller.getSnapshot().details?.snapshot.moves).toHaveLength(moves.length);
      moves.push(humanMove);
      h.store(snapshot(moves));
      pending.resolve(snapshot(moves));
      await sending;
      moves.push(color === "white" ? "e7e5" : "g2g4");
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.api.turn).toHaveBeenCalledTimes(color === "white" ? 1 : 2);
      expect(h.controller.getSnapshot().canMove).toBe(true);
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
    expect(h.controller.getSnapshot().pendingMove).toBe(true);
    expect(h.controller.getSnapshot().canMove).toBe(false);
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
    expect(h.controller.getSnapshot().pendingMove).toBe(false);
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
    expect(h.controller.getSnapshot().pendingMove).toBe(false);
    expect(h.controller.getSnapshot().canMove).toBe(false);
    expect(h.api.turn).not.toHaveBeenCalled();
    await h.controller.recover();
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
  });

  it("requires only the AI key after human-turn recovery and never steps a human seat", async () => {
    const h = harness(humanGame("white"));
    await h.enter();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    await h.controller.resume();
    expect(h.api.controller).not.toHaveBeenCalled();
    h.controller.setKey("black", "ai-key");
    await h.controller.step();
    expect(h.api.controller).not.toHaveBeenCalled();
    await h.controller.resume();
    expect(h.controller.getSnapshot().canMove).toBe(true);
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
    await h.controller.resume();
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
    await h.controller.resume();
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
    const h = harness();
    await h.enter();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    expect(h.api.controller).not.toHaveBeenCalled();
    await h.controller.resume();
    expect(h.api.turn).not.toHaveBeenCalled();
    h.controller.setKey("white", "white-secret-sentinel");
    await h.controller.step();
    expect(h.api.turn).not.toHaveBeenCalled();
    h.controller.setKey("black", "black-secret-sentinel");
    expect(h.api.turn).not.toHaveBeenCalled();
    h.api.turn.mockResolvedValue(
      snapshot(["e2e4"], { state: "paused", version: 2, legalMoves: [] }),
    );
    await h.controller.step();
    expect(h.api.turn.mock.calls[0]?.[0]).toMatchObject({ step: true, expectedVersion: 1 });
    expect(h.api.lifecycle).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().details?.snapshot.state).toBe("paused");
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
  });

  it("halts on heartbeat failure and clears keys and pending requests on lifetime end", async () => {
    const h = harness();
    h.keys();
    h.api.turn.mockReturnValue(new Promise(() => undefined));
    void h.controller.created(details);
    await vi.advanceTimersByTimeAsync(0);
    h.api.controller.mockRejectedValue(new AiRequestFailure("AI_CONTROLLER_LOST"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.controller.getSnapshot().phase).toBe("uncertain");
    const signal = h.api.turn.mock.calls[0]?.[2];
    h.controller.endLifetime();
    expect(signal?.aborted).toBe(true);
    expect(h.controller.credentials).toBeNull();
    expect(h.controller.getSnapshot().details).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.api.turn).toHaveBeenCalledTimes(1);
  });

  it("access loss clears private state without a replacement guest bootstrap", async () => {
    const h = harness();
    await h.enter();
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
