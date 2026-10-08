import { gameReplayResponseSchema, type GameSnapshot } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { emptyExport, emptyReplay } from "../gameplay/archive-state";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";

import type { PendingCommand, SandboxState } from "./state";
import { SandboxStore } from "./store";

/** Checked by tsconfig.tests.json; never invoke invalid transitions at runtime. */
export function checkStateContracts(
  store: SandboxStore,
  accepted: GameSnapshot,
  command: PendingCommand,
) {
  // @ts-expect-error A ready flow must have an accepted snapshot.
  store.transition({ phase: "ready", snapshot: null, pendingCommand: null }, { notice: null });
  store.transition(
    // @ts-expect-error A ready flow cannot have an outstanding command.
    { phase: "ready", snapshot: accepted, pendingCommand: command },
    { notice: null },
  );
  store.transition(
    // @ts-expect-error An uncertain flow must retain its identical command for explicit retry.
    { phase: "uncertain", snapshot: accepted, pendingCommand: null },
    { notice: null },
  );
  store.transition(
    // @ts-expect-error An uncertain command must belong to a loaded snapshot.
    { phase: "uncertain", snapshot: null, pendingCommand: command },
    { notice: null },
  );
  store.transition(
    // @ts-expect-error Recovery cannot issue a pause command before loading a snapshot.
    { phase: "recovering", snapshot: null, pendingCommand: command },
    { notice: null },
  );
  // @ts-expect-error Transition callers must replace the complete flow, not just its phase.
  store.transition({ phase: "submitting" }, { notice: null });
  // @ts-expect-error A manual export must carry selectable PGN text.
  store.setExport({ exportPhase: "manual", exportText: null, exportNotice: null });
  // @ts-expect-error Manual text is required, not an optional detail of the outcome.
  store.setExport({ exportPhase: "manual", exportNotice: null });
  // @ts-expect-error An export error must carry its safe error explanation.
  store.setExport({ exportPhase: "error", exportText: null, exportNotice: null });
  // @ts-expect-error An export error explanation cannot be omitted.
  store.setExport({ exportPhase: "error", exportText: null });
  // @ts-expect-error A successful export cannot retain a previous error explanation.
  store.setExport({ exportPhase: "copied", exportText: null, exportNotice: "network" });
  // @ts-expect-error A replay cursor cannot point into history before its replay is loaded.
  store.setReplay({ replay: null, replayPly: 1, replayPhase: "idle", replayNotice: null });
  // @ts-expect-error A replay error must carry its safe error explanation.
  store.setReplay({ replay: null, replayPly: 0, replayPhase: "error", replayNotice: null });
  // @ts-expect-error A replay error explanation cannot be omitted.
  store.setReplay({ replay: null, replayPly: 0, replayPhase: "error" });
}

function archivedStore() {
  const store = new SandboxStore();
  const accepted = snapshot(FOOLS_MATE);
  const replay = gameReplayResponseSchema.parse({ snapshot: accepted, initialFen: snapshot().fen });
  store.transition(
    { phase: "ready", snapshot: accepted, pendingCommand: null },
    { notice: null, announcement: { kind: "existing", snapshot: accepted } },
  );
  store.setReplay({ replay, replayPly: 2, replayPhase: "idle", replayNotice: null });
  store.setExport({ exportPhase: "manual", exportText: accepted.pgn, exportNotice: null });
  return { store, accepted, replay };
}

describe("typed sandbox store", () => {
  it("publishes complete flow transitions once and leaves previously read states immutable", () => {
    const store = new SandboxStore();
    const accepted = snapshot();
    store.transition(
      { phase: "ready", snapshot: accepted, pendingCommand: null },
      { notice: null },
    );
    const previous = store.get();
    const observed: SandboxState[] = [];
    const unsubscribe = store.subscribe(() => observed.push(store.get()));
    const command: PendingCommand = {
      gameId: accepted.gameId,
      expectedVersion: accepted.version,
      commandId: crypto.randomUUID(),
      move: "e2e4",
    };

    store.transition(
      { phase: "submitting", snapshot: accepted, pendingCommand: command },
      { notice: null, invalidateInteraction: true },
    );

    expect(observed).toEqual([store.get()]);
    expect(observed[0]).toMatchObject({
      phase: "submitting",
      snapshot: accepted,
      pendingCommand: command,
      interactionRevision: previous.interactionRevision + 1,
    });
    expect(previous).toMatchObject({
      phase: "ready",
      pendingCommand: null,
      interactionRevision: 0,
    });
    expect(store.get()).not.toBe(previous);
    unsubscribe();
    store.setReadiness("ready");
    expect(observed).toHaveLength(1);
  });

  it.each([
    { label: "another game", next: snapshot(FOOLS_MATE, { gameId: OTHER_GAME_ID }) },
    { label: "another revision", next: snapshot(FOOLS_MATE, { version: 5 }) },
  ])("clears private archive data atomically when adopting $label", ({ next }) => {
    const { store, accepted, replay } = archivedStore();
    const previous = store.get();
    const observed: SandboxState[] = [];
    store.subscribe(() => observed.push(store.get()));

    store.transition(
      { phase: "ready", snapshot: next, pendingCommand: null },
      { notice: null, announcement: { kind: "existing", snapshot: next } },
    );

    expect(observed).toEqual([store.get()]);
    expect(observed[0]).toMatchObject({ snapshot: next, ...emptyReplay, ...emptyExport });
    expect(previous).toMatchObject({ snapshot: accepted, replay, exportText: accepted.pgn });
  });

  it("clears private data and snapshot-bearing announcements together when access is lost", () => {
    const { store } = archivedStore();
    const observed: SandboxState[] = [];
    store.subscribe(() => observed.push(store.get()));

    store.transition(
      { phase: "access-error", snapshot: null, pendingCommand: null },
      { notice: "UNAUTHORIZED", invalidateInteraction: true },
    );

    expect(observed).toEqual([store.get()]);
    expect(observed[0]).toMatchObject({
      phase: "access-error",
      snapshot: null,
      pendingCommand: null,
      ...emptyReplay,
      ...emptyExport,
      notice: "UNAUTHORIZED",
      announcement: null,
      interactionRevision: 1,
    });
  });

  it("preserves archives across flow and readiness updates for the same accepted revision", () => {
    const { store, accepted, replay } = archivedStore();
    store.transition(
      { phase: "starting", snapshot: accepted, pendingCommand: null },
      { notice: null },
    );
    store.setReadiness("unavailable", true);

    expect(store.get()).toMatchObject({
      phase: "starting",
      snapshot: accepted,
      pendingCommand: null,
      readiness: "unavailable",
      replay,
      replayPly: 2,
      exportPhase: "manual",
      exportText: accepted.pgn,
      announcement: { kind: "connection", readiness: "unavailable" },
      interactionRevision: 0,
    });
  });

  it("replaces replay and export slices independently without erasing the other's result", () => {
    const { store, accepted, replay } = archivedStore();
    store.setReplay({ replay, replayPly: 2, replayPhase: "error", replayNotice: "network" });
    store.setExport({ exportPhase: "error", exportText: null, exportNotice: "timeout" });
    store.setExport({ exportPhase: "loading", exportText: null, exportNotice: null });
    expect(store.get()).toMatchObject({ replayPhase: "error", replayNotice: "network" });
    store.setExport({ exportPhase: "copied", exportText: null, exportNotice: null });
    store.setReplay({ replay, replayPly: 2, replayPhase: "loading", replayNotice: null });

    expect(store.get()).toMatchObject({
      phase: "ready",
      snapshot: accepted,
      pendingCommand: null,
      replay,
      replayPly: 2,
      replayPhase: "loading",
      replayNotice: null,
      exportPhase: "copied",
      exportText: null,
      exportNotice: null,
    });
  });

  it("projects only the selected slice when structurally compatible values contain extra fields", () => {
    const { store, replay } = archivedStore();
    // A full snapshot is structurally compatible with every substate parameter.
    const previous = store.get();
    store.setReadiness("unavailable", true);
    store.setExport({ exportPhase: "copied", exportText: null, exportNotice: null });
    store.setReplay(previous);
    expect(store.get()).toMatchObject({
      readiness: "unavailable",
      exportPhase: "copied",
      exportText: null,
      announcement: { kind: "connection", readiness: "unavailable" },
    });

    store.setReplay({ replay, replayPly: 3, replayPhase: "error", replayNotice: "network" });
    store.setExport(previous);
    expect(store.get()).toMatchObject({
      readiness: "unavailable",
      replayPly: 3,
      replayPhase: "error",
      replayNotice: "network",
      exportPhase: "manual",
    });

    store.setExport({ exportPhase: "copied", exportText: null, exportNotice: null });
    store.transition(previous, { notice: null });
    expect(store.get()).toMatchObject({
      readiness: "unavailable",
      replayPly: 3,
      replayPhase: "error",
      replayNotice: "network",
      exportPhase: "copied",
      exportText: null,
    });
  });

  it("does not install private archives without a terminal accepted snapshot", () => {
    const store = new SandboxStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const replay = gameReplayResponseSchema.parse({
      snapshot: snapshot(FOOLS_MATE),
      initialFen: snapshot().fen,
    });
    for (const accepted of [null, snapshot()]) {
      if (accepted) {
        store.transition(
          { phase: "ready", snapshot: accepted, pendingCommand: null },
          { notice: null },
        );
      }
      const previous = store.get();
      listener.mockClear();
      store.setReplay({ replay, replayPly: 2, replayPhase: "idle", replayNotice: null });
      store.setExport({
        exportPhase: "manual",
        exportText: replay.snapshot.pgn,
        exportNotice: null,
      });
      expect(store.get()).toBe(previous);
      expect(listener).not.toHaveBeenCalled();
    }
  });
});
