import { gameReplayResponseSchema, type GameErrorCode } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiFailure, type SandboxApi } from "../api";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";

import { SandboxController } from "./controller";
import type { SandboxNavigation } from "./navigation";
import type { PgnDelivery } from "./pgn";

function harness(initial = snapshot(), navigation?: SandboxNavigation, delivery?: PgnDelivery) {
  const api = {
    ready: vi.fn<SandboxApi["ready"]>().mockResolvedValue(true),
    bootstrap: vi.fn<SandboxApi["bootstrap"]>().mockResolvedValue(),
    create: vi.fn<SandboxApi["create"]>().mockResolvedValue(initial),
    snapshot: vi.fn<SandboxApi["snapshot"]>().mockResolvedValue(initial),
    move: vi.fn<SandboxApi["move"]>().mockResolvedValue(snapshot(["e2e4"])),
    lifecycle: vi.fn<SandboxApi["lifecycle"]>().mockResolvedValue(initial),
    unfinished: vi.fn<SandboxApi["unfinished"]>().mockResolvedValue(null),
    replay: vi.fn<SandboxApi["replay"]>().mockRejectedValue(new ApiFailure("network")),
    pgn: vi
      .fn<SandboxApi["pgn"]>()
      .mockResolvedValue({ gameId: initial.gameId, version: initial.version, pgn: initial.pgn }),
  };
  const ids = vi.fn(() => crypto.randomUUID());
  const controller = new SandboxController(api, ids, navigation, delivery);
  return { api, controller, ids, initial };
}

async function started(initial = snapshot()) {
  const result = harness(initial);
  await result.controller.checkReadiness();
  await result.controller.start();
  return result;
}

describe("sandbox controller", () => {
  it("starts only on action, serializes bootstrap and immediately deduplicates creation", async () => {
    const { api, controller } = harness();
    await controller.checkReadiness();
    expect(api.bootstrap).not.toHaveBeenCalled();
    const cookie = Promise.withResolvers<void>();
    api.bootstrap.mockReturnValue(cookie.promise);
    const first = controller.start();
    const duplicate = controller.start();
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(api.create).not.toHaveBeenCalled();
    cookie.resolve();
    await Promise.all([first, duplicate]);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("ready");
  });

  it("does not create a game if guest bootstrap fails", async () => {
    const { api, controller } = harness();
    await controller.checkReadiness();
    api.bootstrap.mockRejectedValue(new ApiFailure("network"));
    await controller.start();
    expect(api.create).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ phase: "entry", notice: "network" });
  });

  it("reopens an authorized creation conflict and preserves its paused lifecycle", async () => {
    const { api, controller } = harness();
    const paused = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 12 });
    await controller.checkReadiness();
    api.create.mockRejectedValue(new ApiFailure("api", "GAME_CONFLICT", paused));
    await controller.start();
    await controller.submit("e7e5");
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      notice: "existing",
      snapshot: paused,
    });
    expect(api.move).not.toHaveBeenCalled();
  });

  it("preserves accepted state while pending and uses actual revisions and fresh command IDs", async () => {
    const { api, controller, initial, ids } = await started(snapshot([], { version: 37 }));
    const pending = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.move.mockReturnValueOnce(pending.promise);
    const request = controller.submit("e2e4");
    await controller.submit("d2d4");
    await controller.submit("e2e4");
    expect(api.move).toHaveBeenCalledTimes(1);
    const command = api.move.mock.calls[0]?.[0];
    expect(command).toMatchObject({ expectedVersion: 37, move: "e2e4", gameId: initial.gameId });
    expect(controller.getSnapshot()).toMatchObject({ phase: "submitting", snapshot: initial });
    expect(controller.getSnapshot().snapshot).toBe(initial);
    expect(ids).toHaveBeenCalledTimes(1);
    const next = snapshot(["e2e4"], { version: 41 });
    pending.resolve(next);
    await request;
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      snapshot: next,
      pendingCommand: null,
    });
    api.move.mockResolvedValue(snapshot(["e2e4", "e7e5"], { version: 44 }));
    await controller.submit("e7e5");
    const secondCommand = api.move.mock.calls[1]?.[0];
    expect(secondCommand?.expectedVersion).toBe(41);
    expect(secondCommand?.commandId).not.toBe(command?.commandId);
  });

  it("replaces a conflict snapshot, invalidates interaction and never replays the stale move", async () => {
    const { api, controller } = await started();
    const current = snapshot(["d2d4"]);
    const epoch = controller.getSnapshot().interactionRevision;
    api.move.mockRejectedValue(new ApiFailure("api", "GAME_CONFLICT", current));
    await controller.submit("e2e4");
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: current,
      phase: "ready",
      pendingCommand: null,
      notice: "GAME_CONFLICT",
      interactionRevision: epoch + 1,
      announcement: { kind: "synchronized", snapshot: current },
    });
    expect(api.move).toHaveBeenCalledTimes(1);
    expect(api.snapshot).not.toHaveBeenCalled();
  });

  it.each<GameErrorCode>(["ILLEGAL_MOVE", "INVALID_UCI", "INVALID_REQUEST", "INVALID_GAME_STATE"])(
    "synchronizes a %s rejection before permitting another move",
    async (code) => {
      const { api, controller, initial } = await started();
      const read = Promise.withResolvers<ReturnType<typeof snapshot>>();
      api.move.mockRejectedValue(new ApiFailure("api", code));
      api.snapshot.mockReturnValue(read.promise);
      const request = controller.submit("e2e4");
      await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(1));
      expect(controller.getSnapshot()).toMatchObject({
        phase: "synchronizing",
        snapshot: initial,
        pendingCommand: null,
      });
      await controller.submit("d2d4");
      expect(api.move).toHaveBeenCalledTimes(1);
      read.resolve(initial);
      await request;
      expect(controller.getSnapshot()).toMatchObject({
        phase: "ready",
        notice: code,
        announcement: { kind: "rejected", reason: code },
      });
    },
  );

  it("keeps a rejected move locked if synchronization fails and offers a read-only retry", async () => {
    const { api, controller } = await started();
    api.move.mockRejectedValue(new ApiFailure("api", "ILLEGAL_MOVE"));
    api.snapshot.mockRejectedValueOnce(new ApiFailure("network"));
    await controller.submit("e2e4");
    expect(controller.getSnapshot()).toMatchObject({
      phase: "sync-required",
      pendingCommand: null,
    });
    await controller.retryMove();
    expect(api.move).toHaveBeenCalledTimes(1);
    await controller.synchronize();
    expect(controller.getSnapshot().phase).toBe("ready");
  });

  it.each(["network", "timeout", "malformed", "api"] as const)(
    "retains the exact command after %s uncertainty and an unchanged GET",
    async (kind) => {
      const { api, controller } = await started(snapshot([], { version: 19 }));
      api.move.mockRejectedValueOnce(new ApiFailure(kind));
      await controller.submit("e2e4");
      const original = api.move.mock.calls[0]?.[0];
      expect(controller.getSnapshot()).toMatchObject({
        phase: "uncertain",
        pendingCommand: original,
      });
      await controller.submit("d2d4");
      expect(api.move).toHaveBeenCalledTimes(1);
      const current = snapshot(["e2e4"], { version: 20 });
      api.move.mockRejectedValueOnce(new ApiFailure("api", "GAME_CONFLICT", current));
      await controller.retryMove();
      expect(api.move.mock.calls[1]?.[0]).toBe(original);
      expect(controller.getSnapshot()).toMatchObject({
        phase: "ready",
        pendingCommand: null,
        snapshot: current,
      });
    },
  );

  it("unlocks after a read proves a newer revision, even when another move won the race", async () => {
    const { api, controller } = await started(snapshot([], { version: 30 }));
    const updated = snapshot(["d2d4"], { version: 34 });
    api.move.mockRejectedValue(new ApiFailure("network"));
    api.snapshot.mockResolvedValue(updated);
    await controller.submit("e2e4");
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: updated,
      phase: "ready",
      pendingCommand: null,
    });
    expect(api.move).toHaveBeenCalledTimes(1);
  });

  it("retains uncertainty across failed status checks and deduplicates explicit retries", async () => {
    const { api, controller } = await started();
    api.move.mockRejectedValueOnce(new ApiFailure("timeout"));
    api.snapshot.mockRejectedValue(new ApiFailure("network"));
    await controller.submit("e2e4");
    const original = controller.getSnapshot().pendingCommand;
    await controller.synchronize();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "uncertain",
      pendingCommand: original,
    });
    const retry = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.move.mockReturnValue(retry.promise);
    const first = controller.retryMove();
    await controller.retryMove();
    expect(api.move).toHaveBeenCalledTimes(2);
    retry.resolve(snapshot(["e2e4"]));
    await first;
    expect(controller.getSnapshot().phase).toBe("ready");
  });

  it.each<GameErrorCode>(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "clears loaded state on %s without implicitly bootstrapping",
    async (code) => {
      const { api, controller } = await started();
      api.move.mockRejectedValue(new ApiFailure("api", code));
      await controller.submit("e2e4");
      expect(controller.getSnapshot()).toMatchObject({
        phase: "access-error",
        snapshot: null,
        pendingCommand: null,
        notice: code,
      });
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      await controller.start();
      expect(api.bootstrap).toHaveBeenCalledTimes(2);
    },
  );

  it("also clears a game if access fails during uncertain-response synchronization", async () => {
    const { api, controller } = await started();
    api.move.mockRejectedValue(new ApiFailure("network"));
    api.snapshot.mockRejectedValue(new ApiFailure("api", "UNAUTHORIZED"));
    await controller.submit("e2e4");
    expect(controller.getSnapshot()).toMatchObject({ phase: "access-error", snapshot: null });
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("keeps service readiness separate from sandbox availability and requires explicit retry", async () => {
    const { api, controller } = harness();
    await controller.checkReadiness();
    api.create.mockRejectedValueOnce(new ApiFailure("api", "NOT_FOUND"));
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      readiness: "ready",
      phase: "unavailable",
      notice: "sandbox-unavailable",
    });
    expect(api.create).toHaveBeenCalledTimes(1);
    await controller.start();
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe("ready");
  });

  it("does not start while the service is unavailable", async () => {
    const { api, controller } = harness();
    api.ready.mockResolvedValue(false);
    await controller.checkReadiness();
    await controller.start();
    expect(api.bootstrap).not.toHaveBeenCalled();
    api.ready.mockResolvedValue(true);
    await controller.checkReadiness();
    expect(api.bootstrap).not.toHaveBeenCalled();
    await controller.start();
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("ignores a late creation after disconnect and a newer request generation", async () => {
    const { api, controller } = harness();
    await controller.checkReadiness();
    const first = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.create.mockReturnValueOnce(first.promise);
    const oldRequest = controller.start();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    controller.disconnect();
    const disconnect = controller.connect();
    await vi.waitFor(() => expect(controller.getSnapshot().readiness).toBe("ready"));
    const newer = snapshot([], { gameId: OTHER_GAME_ID });
    api.create.mockResolvedValue(newer);
    await controller.start();
    first.resolve(snapshot());
    await oldRequest;
    expect(controller.getSnapshot().snapshot).toBe(newer);
    disconnect();
  });

  it("ignores a late move response after a newer retry has completed", async () => {
    const { api, controller } = await started();
    const first = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.move.mockReturnValueOnce(first.promise);
    const oldRequest = controller.submit("e2e4");
    const original = controller.getSnapshot().pendingCommand;
    controller.disconnect();
    const disconnect = controller.connect();
    const newer = snapshot(["e2e4", "e7e5"]);
    api.move.mockRejectedValueOnce(new ApiFailure("api", "GAME_CONFLICT", newer));
    await controller.retryMove();
    first.resolve(snapshot(["e2e4"]));
    await oldRequest;
    expect(api.move.mock.calls[1]?.[0]).toBe(original);
    expect(controller.getSnapshot().snapshot).toBe(newer);
    disconnect();
  });

  it("rejects regressing or wrong-game responses instead of replacing the accepted board", async () => {
    const { api, controller, initial } = await started(snapshot([], { version: 10 }));
    api.move.mockResolvedValue(snapshot(["e2e4"], { gameId: OTHER_GAME_ID, version: 12 }));
    api.snapshot.mockResolvedValue(snapshot([], { version: 9 }));
    await controller.submit("e2e4");
    expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", snapshot: initial });
  });

  it("locks terminal games and allows a new game only after completion", async () => {
    const { api, controller } = await started(snapshot(FOOLS_MATE));
    await controller.submit("e2e4");
    expect(api.move).not.toHaveBeenCalled();
    const next = snapshot([], { gameId: OTHER_GAME_ID });
    api.create.mockResolvedValue(next);
    await controller.start();
    expect(controller.getSnapshot().snapshot).toBe(next);
  });
});

describe("automatic paused recovery and lifecycle commands", () => {
  it("ignores obsolete discovery during duplicate mounts and pauses only the current recovery", async () => {
    const initial = snapshot(["e2e4"]);
    const paused = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 });
    const { api, controller } = harness(initial);
    const obsolete = Promise.withResolvers<ReturnType<typeof snapshot> | null>();
    const current = Promise.withResolvers<ReturnType<typeof snapshot> | null>();
    api.unfinished.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    api.lifecycle.mockResolvedValue(paused);
    controller.connect()();
    const disconnect = controller.connect();
    obsolete.resolve(initial);
    await Promise.resolve();
    expect(api.lifecycle).not.toHaveBeenCalled();
    await controller.recover();
    expect(api.unfinished).toHaveBeenCalledTimes(2);
    current.resolve(initial);
    await vi.waitFor(() => expect(controller.getSnapshot().snapshot).toEqual(paused));
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    expect(api.bootstrap).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("ready");
    disconnect();
  });

  it("preserves an uncertain pause across remounts and ignores the obsolete accepted response", async () => {
    const initial = snapshot(["e2e4"]);
    const paused = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 });
    const { api, controller } = harness(initial);
    const obsolete = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.unfinished.mockResolvedValue(initial);
    api.lifecycle.mockReturnValueOnce(obsolete.promise);
    const firstDisconnect = controller.connect();
    await vi.waitFor(() => expect(api.lifecycle).toHaveBeenCalledTimes(1));
    const command = controller.getSnapshot().pendingCommand;
    firstDisconnect();
    const disconnect = controller.connect();
    obsolete.resolve(paused);
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: initial,
      pendingCommand: command,
      phase: "uncertain",
    });
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    api.lifecycle.mockRejectedValueOnce(new ApiFailure("api", "GAME_CONFLICT", paused));
    await controller.retryMove();
    expect(api.lifecycle.mock.calls[1]?.[0]).toBe(command);
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: paused,
      pendingCommand: null,
      phase: "ready",
    });
    expect(api.bootstrap).not.toHaveBeenCalled();
    disconnect();
  });

  it("discovers the existing game without bootstrap and requires an explicit resume", async () => {
    const initial = snapshot(["e2e4"], { version: 7 });
    const paused = snapshot(["e2e4"], { state: "paused", version: 8, legalMoves: [] });
    const { api, controller } = harness(initial);
    api.unfinished.mockResolvedValue(initial);
    api.lifecycle.mockResolvedValue(paused);
    const disconnect = controller.connect();
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({ phase: "ready", snapshot: paused }),
    );
    expect(api.bootstrap).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.lifecycle.mock.calls[0]?.[0]).toMatchObject({ action: "pause", expectedVersion: 7 });
    await controller.submit("e7e5");
    expect(api.move).not.toHaveBeenCalled();
    const resumed = { ...initial, version: 9 };
    api.lifecycle.mockResolvedValue(resumed);
    await controller.lifecycle({ action: "resume" });
    expect(controller.getSnapshot().snapshot).toEqual(resumed);
    disconnect();
  });

  it("does not write when reopening a paused game and treats anonymous discovery as entry", async () => {
    const paused = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 9 });
    const { api, controller } = harness(paused);
    api.unfinished.mockResolvedValueOnce(paused);
    await controller.recover();
    expect(api.lifecycle).not.toHaveBeenCalled();
    expect(controller.getSnapshot().snapshot).toEqual(paused);
    const anonymous = harness();
    anonymous.api.unfinished.mockRejectedValue(new ApiFailure("api", "UNAUTHORIZED"));
    await anonymous.controller.recover();
    expect(anonymous.controller.getSnapshot()).toMatchObject({
      phase: "entry",
      snapshot: null,
      notice: null,
    });
    expect(anonymous.api.bootstrap).not.toHaveBeenCalled();
  });

  it("bounds recovery conflict retries and never enables an active recovered board", async () => {
    const { api, controller } = harness();
    api.unfinished.mockResolvedValue(snapshot());
    for (const version of [1, 2, 3])
      api.lifecycle.mockRejectedValueOnce(
        new ApiFailure("api", "GAME_CONFLICT", snapshot(["e2e4"], { version })),
      );
    await controller.recover();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "recovery-required",
      pendingCommand: null,
    });
    expect(api.lifecycle).toHaveBeenCalledTimes(3);
    expect(api.lifecycle.mock.calls.map(([command]) => command.expectedVersion)).toEqual([0, 1, 2]);
    await controller.submit("e7e5");
    await controller.lifecycle({ action: "resume" });
    expect(api.move).not.toHaveBeenCalled();
    expect(api.lifecycle).toHaveBeenCalledTimes(3);
    api.snapshot.mockResolvedValue(snapshot(["e2e4"], { version: 3 }));
    api.lifecycle.mockResolvedValue(
      snapshot(["e2e4"], { version: 4, state: "paused", legalMoves: [] }),
    );
    await controller.recover();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      snapshot: { state: "paused", version: 4 },
    });
  });

  it("keeps a lost recovery pause uncertain and retries the identical command", async () => {
    const { api, controller } = harness(snapshot(["e2e4"]));
    api.unfinished.mockResolvedValue(snapshot(["e2e4"]));
    api.lifecycle.mockRejectedValueOnce(new ApiFailure("timeout"));
    await controller.recover();
    const original = controller.getSnapshot().pendingCommand;
    expect(original).toMatchObject({ action: "pause", expectedVersion: 1 });
    expect(controller.getSnapshot().phase).toBe("uncertain");
    await controller.lifecycle({ action: "abort" });
    await controller.submit("e7e5");
    api.lifecycle.mockResolvedValue(
      snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 }),
    );
    await controller.retryMove();
    expect(api.lifecycle.mock.calls[1]?.[0]).toBe(original);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      snapshot: { state: "paused" },
    });
  });

  it("serializes lifecycle actions with moves and preserves their exact retry payload", async () => {
    const { api, controller, initial } = await started();
    const pending = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.lifecycle.mockReturnValueOnce(pending.promise);
    const request = controller.lifecycle({ action: "resign", losingColor: "black" });
    await controller.submit("e2e4");
    await controller.lifecycle({ action: "pause" });
    expect(api.move).not.toHaveBeenCalled();
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    pending.reject(new ApiFailure("network"));
    await request;
    expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", snapshot: initial });
    const original = controller.getSnapshot().pendingCommand;
    const terminal = snapshot([], {
      state: "completed",
      result: "1-0",
      terminationReason: "human_resignation",
      legalMoves: [],
      version: 1,
      pgn: '[Result "1-0"]\n\n1-0',
    });
    api.lifecycle.mockResolvedValue(terminal);
    await controller.retryMove();
    expect(api.lifecycle.mock.calls[1]?.[0]).toBe(original);
    expect(controller.getSnapshot()).toMatchObject({ phase: "ready", snapshot: terminal });
  });

  it("opens private URLs and ignores a late response after history navigation", async () => {
    let listener = () => {};
    let target = OTHER_GAME_ID;
    const navigation: SandboxNavigation = {
      read: () => target,
      open: vi.fn(),
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
    };
    const { api, controller } = harness(snapshot(), navigation);
    const late = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.snapshot.mockReturnValueOnce(late.promise);
    const disconnect = controller.connect();
    target = snapshot().gameId;
    const paused = snapshot([], { state: "paused", legalMoves: [], version: 3 });
    api.snapshot.mockResolvedValue(paused);
    listener();
    await vi.waitFor(() => expect(controller.getSnapshot().snapshot).toEqual(paused));
    late.resolve(snapshot([], { gameId: OTHER_GAME_ID }));
    await Promise.resolve();
    expect(controller.getSnapshot().snapshot).toEqual(paused);
    expect(api.bootstrap).not.toHaveBeenCalled();
    disconnect();
  });
});

describe("private terminal replay and export", () => {
  async function terminal() {
    const initial = snapshot(FOOLS_MATE);
    const delivery = {
      copy: vi.fn<PgnDelivery["copy"]>().mockResolvedValue(true),
      download: vi.fn<PgnDelivery["download"]>(),
    };
    const result = harness(initial, undefined, delivery);
    result.api.replay.mockResolvedValue(
      gameReplayResponseSchema.parse({ snapshot: initial, initialFen: snapshot().fen }),
    );
    await result.controller.checkReadiness();
    await result.controller.start();
    await vi.waitFor(() => expect(result.controller.getSnapshot().replay).not.toBeNull());
    return { ...result, delivery };
  }
  it("keeps replay selection separate from the accepted snapshot and sends no moves", async () => {
    const { api, controller, initial } = await terminal();
    expect(controller.getSnapshot().replayPly).toBe(4);
    for (const ply of [0, 1, 3, 4]) controller.selectPly(ply);
    controller.selectPly(-1);
    controller.selectPly(99);
    controller.selectPly(1.5);
    expect(controller.getSnapshot().replayPly).toBe(4);
    expect(controller.getSnapshot().snapshot).toBe(initial);
    expect(api.replay).toHaveBeenCalledTimes(1);
    expect(api.move).not.toHaveBeenCalled();
    expect(api.lifecycle).not.toHaveBeenCalled();
  });
  it("copies/downloads exact authorized PGN and offers manual text if the clipboard is denied", async () => {
    const { controller, delivery, initial } = await terminal();
    await controller.exportPgn("copy");
    expect(delivery.copy).toHaveBeenCalledWith(initial.pgn);
    expect(controller.getSnapshot().exportPhase).toBe("copied");
    delivery.copy.mockResolvedValue(false);
    await controller.exportPgn("copy");
    expect(controller.getSnapshot()).toMatchObject({
      exportPhase: "manual",
      exportText: initial.pgn,
    });
    await controller.exportPgn("download");
    expect(delivery.download).toHaveBeenCalledWith(initial.pgn, initial.gameId);
    expect(controller.getSnapshot().exportText).toBeNull();
  });
  it("rejects mismatched exports and clears all private data on access loss", async () => {
    const { api, controller, delivery, initial } = await terminal();
    api.pgn.mockResolvedValueOnce({
      gameId: initial.gameId,
      version: initial.version + 1,
      pgn: initial.pgn,
    });
    await controller.exportPgn("copy");
    expect(delivery.copy).not.toHaveBeenCalled();
    expect(controller.getSnapshot().archiveNotice).toBe("malformed");
    api.pgn.mockRejectedValueOnce(new ApiFailure("api", "UNAUTHORIZED"));
    await controller.exportPgn("download");
    expect(delivery.download).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "access-error",
      snapshot: null,
      replay: null,
      exportText: null,
    });
  });
  it("ignores a late replay after export reports lost access", async () => {
    const initial = snapshot(FOOLS_MATE);
    const { api, controller } = harness(initial);
    const late = Promise.withResolvers<Awaited<ReturnType<SandboxApi["replay"]>>>();
    api.replay.mockReturnValue(late.promise);
    await controller.checkReadiness();
    await controller.start();
    api.pgn.mockRejectedValue(new ApiFailure("api", "NOT_FOUND"));
    await controller.exportPgn("copy");
    late.resolve(gameReplayResponseSchema.parse({ snapshot: initial, initialFen: snapshot().fen }));
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: null,
      replay: null,
      phase: "access-error",
    });
  });
});
