import {
  type GameReplayResponse,
  gameReplayResponseSchema,
  type GameSnapshot,
} from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../api/failures";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";

import { type ArchiveContext, ArchiveController, type ArchiveStore } from "./archive";
import { type ArchiveFeedback, emptyExport, emptyReplay } from "./archive-state";
import type { PgnDelivery } from "./pgn";

function harness(initial: GameSnapshot | null = snapshot(FOOLS_MATE)) {
  let state: ReturnType<ArchiveStore["get"]> = {
    snapshot: initial,
    ...emptyReplay,
    ...emptyExport,
  };
  let connected = true;
  const feedback: ArchiveFeedback[] = [];
  const store: ArchiveStore = {
    get: () => state,
    setReplay(replay, update) {
      state = { ...state, ...replay };
      if (update) feedback.push(update);
    },
    setExport(exported, update) {
      state = { ...state, ...exported };
      if (update) feedback.push(update);
    },
  };
  const accepted = initial ?? snapshot(FOOLS_MATE);
  const replay = gameReplayResponseSchema.parse({
    snapshot:
      accepted.state === "completed" || accepted.state === "aborted"
        ? accepted
        : snapshot(FOOLS_MATE),
    initialFen: snapshot().fen,
  });
  const pgn = { gameId: accepted.gameId, version: accepted.version, pgn: accepted.pgn };
  const api = {
    replay: vi.fn<ArchiveContext["api"]["replay"]>().mockResolvedValue(replay),
    pgn: vi.fn<ArchiveContext["api"]["pgn"]>().mockResolvedValue(pgn),
  };
  const delivery = {
    copy: vi.fn<PgnDelivery["copy"]>().mockResolvedValue(true),
    download: vi.fn<PgnDelivery["download"]>(),
  };
  const loseAccess = vi.fn<ArchiveContext["loseAccess"]>().mockReturnValue(false);
  const controller = new ArchiveController({
    api,
    delivery,
    store,
    isConnected: () => connected,
    loseAccess,
  });
  return {
    controller,
    api,
    delivery,
    store,
    feedback,
    loseAccess,
    accepted,
    replay,
    pgn,
    disconnect: () => {
      connected = false;
    },
    replaceSnapshot: (next: GameSnapshot) => {
      state = { snapshot: next, ...emptyReplay, ...emptyExport };
    },
  };
}

describe("private terminal archive", () => {
  it.each([
    { label: "completed", initial: snapshot(FOOLS_MATE) },
    {
      label: "aborted",
      initial: snapshot(["e2e4"], {
        state: "aborted",
        terminationReason: "aborted",
        legalMoves: [],
        version: 2,
      }),
    },
  ])("loads the complete accepted $label replay at its final ply", async ({ initial }) => {
    const h = harness(initial);
    await h.controller.loadReplay();
    expect(h.api.replay).toHaveBeenCalledExactlyOnceWith(initial.gameId, expect.any(AbortSignal));
    expect(h.store.get()).toMatchObject({
      snapshot: initial,
      replay: h.replay,
      replayPly: initial.moves.length,
      replayPhase: "idle",
      replayNotice: null,
    });
  });

  it.each([
    { label: "no game", initial: null },
    { label: "an active game", initial: snapshot() },
    { label: "a paused game", initial: snapshot([], { state: "paused", legalMoves: [] }) },
    { label: "a disconnected owner", initial: snapshot(FOOLS_MATE) },
  ])("does not read or deliver archives for $label", async ({ label, initial }) => {
    const h = harness(initial);
    if (label === "a disconnected owner") h.disconnect();
    const before = h.store.get();
    await h.controller.loadReplay();
    await h.controller.exportPgn("copy");
    await h.controller.exportPgn("download");
    h.controller.selectPly(1);
    expect(h.store.get()).toBe(before);
    expect(h.api.replay).not.toHaveBeenCalled();
    expect(h.api.pgn).not.toHaveBeenCalled();
    expect(h.delivery.copy).not.toHaveBeenCalled();
    expect(h.delivery.download).not.toHaveBeenCalled();
  });

  it("keeps the replay cursor separate from accepted state and rejects invalid plies", async () => {
    const h = harness();
    await h.controller.loadReplay();
    for (const ply of [0, 1, 3, 4]) {
      h.controller.selectPly(ply);
      expect(h.store.get().replayPly).toBe(ply);
      expect(h.store.get().snapshot).toBe(h.accepted);
      expect(h.feedback.at(-1)).toEqual({
        invalidateInteraction: true,
        announcement: { kind: "replay", ply, san: h.accepted.moves[ply - 1]?.san ?? null },
      });
    }
    const before = h.store.get();
    const feedbackCount = h.feedback.length;
    for (const ply of [-1, 99, 1.5, NaN]) h.controller.selectPly(ply);
    expect(h.store.get()).toBe(before);
    expect(h.feedback).toHaveLength(feedbackCount);
    expect(h.api.replay).toHaveBeenCalledOnce();
    expect(h.api.pgn).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a later revision", other: snapshot(FOOLS_MATE, { version: 5 }) },
    {
      label: "a different terminal history",
      other: snapshot(["e2e4", "f7f6", "d2d4", "g7g5", "d1h5"]),
    },
    {
      label: "a different position with matching version and PGN",
      other: { ...snapshot(FOOLS_MATE), inCheck: false },
    },
    {
      label: "an altered move record with matching version and PGN",
      other: {
        ...snapshot(FOOLS_MATE),
        moves: snapshot(FOOLS_MATE).moves.map((move) =>
          move.ply === 4 ? { ...move, san: "Qh4" } : move,
        ),
      },
    },
  ])("rejects a replay of $label and allows a verified retry", async ({ other }) => {
    const h = harness();
    h.api.replay.mockResolvedValueOnce(
      gameReplayResponseSchema.parse({ ...h.replay, snapshot: other }),
    );
    await h.controller.loadReplay();
    expect(h.store.get()).toMatchObject({
      snapshot: h.accepted,
      replay: null,
      replayPhase: "error",
      replayNotice: "malformed",
    });
    expect(h.store.get().snapshot).toBe(h.accepted);
    await h.controller.loadReplay();
    expect(h.store.get()).toMatchObject({
      replay: h.replay,
      replayPly: 4,
      replayPhase: "idle",
      replayNotice: null,
    });
  });

  it.each([
    { field: "gameId", mismatch: { gameId: OTHER_GAME_ID } },
    { field: "version", mismatch: { version: 5 } },
    { field: "pgn", mismatch: { pgn: "1. f3 e5 2. g4 Qh4# 0-1" } },
  ])("rejects mismatched PGN $field before any delivery", async ({ mismatch }) => {
    const h = harness();
    h.api.pgn.mockResolvedValue({ ...h.pgn, ...mismatch });
    for (const action of ["copy", "download"] as const) {
      await h.controller.exportPgn(action);
      expect(h.store.get()).toMatchObject({
        snapshot: h.accepted,
        exportPhase: "error",
        exportNotice: "malformed",
        exportText: null,
      });
    }
    expect(h.delivery.copy).not.toHaveBeenCalled();
    expect(h.delivery.download).not.toHaveBeenCalled();
  });

  it("copies/downloads exact authorized PGN and offers manual text if the clipboard is denied", async () => {
    const h = harness();
    await h.controller.exportPgn("copy");
    expect(h.api.pgn).toHaveBeenCalledExactlyOnceWith(h.accepted.gameId, expect.any(AbortSignal));
    expect(h.delivery.copy).toHaveBeenCalledExactlyOnceWith(h.accepted.pgn);
    expect(h.store.get()).toMatchObject({ exportPhase: "copied", exportText: null });
    expect(h.feedback.at(-1)).toEqual({ announcement: { kind: "notice", notice: "pgn-copied" } });
    h.delivery.copy.mockResolvedValueOnce(false);
    await h.controller.exportPgn("copy");
    expect(h.delivery.copy).toHaveBeenLastCalledWith(h.accepted.pgn);
    expect(h.store.get()).toMatchObject({ exportPhase: "manual", exportText: h.accepted.pgn });
    expect(h.feedback.at(-1)).toEqual({ announcement: { kind: "notice", notice: "pgn-manual" } });
    await h.controller.exportPgn("download");
    expect(h.delivery.download).toHaveBeenCalledExactlyOnceWith(h.accepted.pgn, h.accepted.gameId);
    expect(h.store.get()).toMatchObject({ exportPhase: "downloaded", exportText: null });
    expect(h.feedback.at(-1)).toEqual({
      announcement: { kind: "notice", notice: "pgn-downloaded" },
    });
  });

  it("runs replay and export independently with one pending request per slot", async () => {
    const h = harness();
    const replay = Promise.withResolvers<GameReplayResponse>();
    const pgn = Promise.withResolvers<typeof h.pgn>();
    h.api.replay.mockReturnValueOnce(replay.promise);
    h.api.pgn.mockReturnValueOnce(pgn.promise);
    const reading = h.controller.loadReplay();
    const exporting = h.controller.exportPgn("download");
    await h.controller.loadReplay();
    await h.controller.exportPgn("copy");
    expect(h.api.replay).toHaveBeenCalledOnce();
    expect(h.api.pgn).toHaveBeenCalledOnce();
    expect(h.store.get()).toMatchObject({ replayPhase: "loading", exportPhase: "loading" });
    pgn.resolve(h.pgn);
    await exporting;
    expect(h.store.get()).toMatchObject({ replayPhase: "loading", exportPhase: "downloaded" });
    replay.resolve(h.replay);
    await reading;
    expect(h.store.get()).toMatchObject({
      replay: h.replay,
      replayPhase: "idle",
      exportPhase: "downloaded",
    });
  });

  it.each(["replay", "export"] as const)(
    "preserves verified replay, cursor and the other archive error while retrying %s",
    async (operation) => {
      const h = harness();
      await h.controller.loadReplay();
      h.controller.selectPly(1);
      h.api.replay.mockRejectedValueOnce(new ApiFailure("network"));
      h.api.pgn.mockRejectedValueOnce(new ApiFailure("timeout"));
      await h.controller.loadReplay();
      await h.controller.exportPgn("copy");
      expect(h.store.get()).toMatchObject({
        replay: h.replay,
        replayPly: 1,
        replayPhase: "error",
        replayNotice: "network",
        exportPhase: "error",
        exportNotice: "timeout",
      });
      h.controller.selectPly(2);
      expect(h.store.get()).toMatchObject({ replayPly: 2, replayNotice: "network" });
      const retry =
        operation === "replay" ? h.controller.loadReplay() : h.controller.exportPgn("copy");
      const preserved =
        operation === "replay"
          ? { replayNotice: null, exportPhase: "error", exportNotice: "timeout" }
          : { exportNotice: null, replayPhase: "error", replayNotice: "network" };
      expect(h.store.get()).toMatchObject({
        ...preserved,
        replay: h.replay,
        replayPly: 2,
        [`${operation}Phase`]: "loading",
      });
      await retry;
      expect(h.store.get()).toMatchObject({
        ...preserved,
        replayPly: operation === "replay" ? 4 : 2,
        [`${operation}Phase`]: operation === "replay" ? "idle" : "copied",
      });
    },
  );

  it("cancels both pending slots while retaining verified replay selection", async () => {
    const h = harness();
    await h.controller.loadReplay();
    h.controller.selectPly(1);
    const replay = Promise.withResolvers<GameReplayResponse>();
    const pgn = Promise.withResolvers<typeof h.pgn>();
    h.api.replay.mockReturnValueOnce(replay.promise);
    h.api.pgn.mockReturnValueOnce(pgn.promise);
    const reading = h.controller.loadReplay();
    const exporting = h.controller.exportPgn("copy");
    h.controller.cancel();
    expect(h.api.replay.mock.calls[1]?.[1].aborted).toBe(true);
    expect(h.api.pgn.mock.calls[0]?.[1].aborted).toBe(true);
    expect(h.store.get()).toEqual({
      snapshot: h.accepted,
      replay: h.replay,
      replayPly: 1,
      replayPhase: "idle",
      replayNotice: null,
      ...emptyExport,
    });
    const cancelled = h.store.get();
    replay.resolve(h.replay);
    pgn.resolve(h.pgn);
    await Promise.all([reading, exporting]);
    expect(h.store.get()).toBe(cancelled);
    expect(h.delivery.copy).not.toHaveBeenCalled();
  });

  it.each(["response", "failure"] as const)(
    "an old %s cannot publish or release either newer request slot after cancellation",
    async (outcome) => {
      const h = harness();
      const oldReplay = Promise.withResolvers<GameReplayResponse>();
      const nextReplay = Promise.withResolvers<GameReplayResponse>();
      const oldPgn = Promise.withResolvers<typeof h.pgn>();
      const nextPgn = Promise.withResolvers<typeof h.pgn>();
      h.api.replay.mockReturnValueOnce(oldReplay.promise).mockReturnValueOnce(nextReplay.promise);
      h.api.pgn.mockReturnValueOnce(oldPgn.promise).mockReturnValueOnce(nextPgn.promise);
      const oldReading = h.controller.loadReplay();
      const oldExporting = h.controller.exportPgn("download");
      h.controller.cancel();
      const reading = h.controller.loadReplay();
      const exporting = h.controller.exportPgn("copy");
      const pending = h.store.get();
      if (outcome === "response") {
        oldReplay.resolve(h.replay);
        oldPgn.resolve(h.pgn);
      } else {
        oldReplay.reject(new ApiFailure("api", "NOT_FOUND"));
        oldPgn.reject(new ApiFailure("api", "FORBIDDEN"));
      }
      await Promise.all([oldReading, oldExporting]);
      expect(h.store.get()).toBe(pending);
      expect(h.loseAccess).not.toHaveBeenCalled();
      expect(h.delivery.download).not.toHaveBeenCalled();
      expect(h.delivery.copy).not.toHaveBeenCalled();
      await h.controller.loadReplay();
      await h.controller.exportPgn("copy");
      expect(h.api.replay).toHaveBeenCalledTimes(2);
      expect(h.api.pgn).toHaveBeenCalledTimes(2);
      nextReplay.resolve(h.replay);
      nextPgn.resolve(h.pgn);
      await Promise.all([reading, exporting]);
      expect(h.store.get()).toMatchObject({
        replay: h.replay,
        replayPhase: "idle",
        exportPhase: "copied",
      });
      expect(h.delivery.copy).toHaveBeenCalledExactlyOnceWith(h.accepted.pgn);
    },
  );

  it.each(
    (["revision", "game", "connection"] as const).flatMap((replacement) =>
      (["response", "failure"] as const).map((outcome) => ({ replacement, outcome })),
    ),
  )(
    "ignores late archive $outcome after $replacement replacement",
    async ({ replacement, outcome }) => {
      const h = harness();
      const replay = Promise.withResolvers<GameReplayResponse>();
      const pgn = Promise.withResolvers<typeof h.pgn>();
      h.api.replay.mockReturnValueOnce(replay.promise);
      h.api.pgn.mockReturnValueOnce(pgn.promise);
      const reading = h.controller.loadReplay();
      const exporting = h.controller.exportPgn("download");
      if (replacement === "connection") h.disconnect();
      else {
        h.replaceSnapshot({
          ...h.accepted,
          ...(replacement === "game" ? { gameId: OTHER_GAME_ID } : { version: 5 }),
        });
      }
      const replaced = h.store.get();
      if (outcome === "response") {
        replay.resolve(h.replay);
        pgn.resolve(h.pgn);
      } else {
        replay.reject(new ApiFailure("api", "NOT_FOUND"));
        pgn.reject(new ApiFailure("api", "FORBIDDEN"));
      }
      await Promise.all([reading, exporting]);
      expect(h.store.get()).toBe(replaced);
      expect(h.feedback).toEqual([]);
      expect(h.loseAccess).not.toHaveBeenCalled();
      expect(h.delivery.copy).not.toHaveBeenCalled();
      expect(h.delivery.download).not.toHaveBeenCalled();
    },
  );

  it.each(
    (["cancel", "revision"] as const).flatMap((replacement) =>
      (["copied", "manual", "failure"] as const).map((outcome) => ({ replacement, outcome })),
    ),
  )("ignores late clipboard $outcome after $replacement", async ({ replacement, outcome }) => {
    const h = harness();
    const clipboard = Promise.withResolvers<boolean>();
    h.delivery.copy.mockReturnValueOnce(clipboard.promise);
    const exporting = h.controller.exportPgn("copy");
    await Promise.resolve();
    expect(h.delivery.copy).toHaveBeenCalledExactlyOnceWith(h.accepted.pgn);
    if (replacement === "cancel") h.controller.cancel();
    else h.replaceSnapshot({ ...h.accepted, version: 5 });
    const replaced = h.store.get();
    if (outcome === "failure") clipboard.reject(new Error("clipboard unavailable"));
    else clipboard.resolve(outcome === "copied");
    await exporting;
    expect(h.store.get()).toBe(replaced);
    expect(h.store.get().exportText).toBeNull();
    expect(h.feedback).toEqual([]);
    expect(h.loseAccess).not.toHaveBeenCalled();
  });
});
