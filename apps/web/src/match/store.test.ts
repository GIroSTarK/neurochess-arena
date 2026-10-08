import { gameReplayResponseSchema } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { emptyExport, emptyReplay } from "../gameplay/archive-state";
import { invocationRecords } from "../test/ai-invocations";
import { FOOLS_MATE, GAME_ID, snapshot } from "../test/fixtures";
import { matchDetails } from "../test/match-session";

import { emptySeatKeys, idleActivity, type MatchFlow } from "./state";
import { MatchStore } from "./store";

function flow(terminal = false): MatchFlow {
  return {
    phase: "ready",
    details: { ...matchDetails("white"), snapshot: snapshot(terminal ? FOOLS_MATE : []) },
    activity: { ...idleActivity, lease: true, running: true },
    speed: 1500,
    issue: null,
    startedGameId: null,
  };
}

describe("MatchStore", () => {
  it("publishes availability from complete flow changes and preserves prior snapshots", () => {
    const store = new MatchStore();
    store.setFlow(flow());
    const previous = store.get();
    const observed = vi.fn(() => store.get());
    const unsubscribe = store.subscribe(observed);
    const command = {
      gameId: GAME_ID,
      expectedVersion: 0,
      commandId: crypto.randomUUID(),
      move: "e2e4",
    };
    store.setActivity({ ...store.getActivity(), busy: true, humanCommand: command });
    expect(observed.mock.results[0]?.value).toMatchObject({
      busy: true,
      pendingMove: true,
      canMove: false,
    });
    expect(previous).toMatchObject({ busy: false, pendingMove: false, canMove: true });
    unsubscribe();
    store.setActivity(idleActivity);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(store.get()).toMatchObject({ pendingMove: false, canMove: false });
  });

  it("clears archive data with a new revision while retaining received telemetry", () => {
    const store = new MatchStore();
    const terminal = flow(true);
    store.setFlow(terminal);
    store.setReplay({
      ...emptyReplay,
      replay: gameReplayResponseSchema.parse({
        snapshot: store.snapshot(),
        initialFen: snapshot().fen,
      }),
      replayPly: 4,
    });
    store.setExport({ exportPhase: "manual", exportText: "private PGN", exportNotice: null });
    const records = invocationRecords();
    store.setInvocations({ phase: "idle", records, moveCount: 2 });
    const observed = vi.fn(() => store.get());
    store.subscribe(observed);
    store.setFlow({
      ...terminal,
      phase: "ready",
      details: { ...matchDetails(), snapshot: { ...store.snapshot(), version: 5 } },
    });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.results[0]?.value).toMatchObject({
      details: { snapshot: { version: 5 } },
      replay: null,
      exportText: null,
      exportResult: null,
      invocations: records,
      invocationsMoveCount: 2,
    });
  });

  it("isolates archive slots when a caller supplies a wider stale slice", () => {
    const store = new MatchStore();
    store.setFlow(flow(true));
    const stale = store.getArchive();
    store.setExport({ exportPhase: "manual", exportText: "private PGN", exportNotice: null });
    store.setReplay({ ...stale, replayPhase: "loading", replayNotice: null });
    expect(store.get()).toMatchObject({
      replayLoading: true,
      exportResult: "manual",
      exportText: "private PGN",
    });
    const loading = store.getArchive();
    store.setReplay({
      ...emptyReplay,
      replay: gameReplayResponseSchema.parse({
        snapshot: store.snapshot(),
        initialFen: snapshot().fen,
      }),
      replayPly: 3,
    });
    store.setExport({ ...loading, ...emptyExport });
    expect(store.get()).toMatchObject({ replayPly: 3, replayLoading: false, exportResult: null });
  });

  it("clears all private slices and pending lanes in one reset notification", () => {
    const store = new MatchStore();
    store.setFlow(flow(true));
    store.setSeats({ ...emptySeatKeys, black: { source: "saved", credentialId: GAME_ID } });
    store.setExport({ exportPhase: "manual", exportText: "private PGN", exportNotice: null });
    store.setInvocations({ phase: "error", records: invocationRecords(), moveCount: 2 });
    const observed = vi.fn(() => store.get());
    store.subscribe(observed);
    store.reset();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.results[0]?.value).toMatchObject({
      details: null,
      invocations: null,
      invocationsError: false,
      replay: null,
      exportText: null,
      pendingMove: false,
      pendingControl: false,
      canMove: false,
      keys: { white: false, black: false },
      selections: { white: "session", black: "session" },
      keyEpoch: 1,
    });
  });
});
