import { gameReplayResponseSchema } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../api/client";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";
import { harness } from "../test/sandbox-controller";

import { SandboxController } from "./controller";
import type { SandboxState } from "./state";

describe("sandbox recovery and navigation", () => {
  it("does not dispatch obsolete seeded recovery during a StrictMode reconnect", async () => {
    const { api, controller } = harness();
    const initial = snapshot();
    api.lifecycle.mockResolvedValue(snapshot([], { state: "paused", legalMoves: [], version: 1 }));
    const entry = {
      target: { kind: "game" as const, gameId: initial.gameId },
      snapshot: initial,
      readiness: true,
    };
    controller.connect(entry)();
    controller.connect(entry);
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    expect(api.snapshot).not.toHaveBeenCalled();
    controller.endLifetime();
  });

  it("seeds readiness and recovery without repeating loader reads", async () => {
    const { api } = harness();
    const initial = snapshot();
    const paused = snapshot([], { state: "paused", legalMoves: [], version: 1 });
    api.lifecycle.mockResolvedValue(paused);
    const onGame = vi.fn();
    const controller = new SandboxController(api, undefined, onGame);
    controller.connect({
      target: { kind: "game", gameId: initial.gameId },
      snapshot: initial,
      readiness: true,
    });
    await vi.waitFor(() => expect(controller.getSnapshot().snapshot).toEqual(paused));
    expect(api.ready).not.toHaveBeenCalled();
    expect(api.snapshot).not.toHaveBeenCalled();
    expect(api.unfinished).not.toHaveBeenCalled();
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    expect(onGame).toHaveBeenCalledWith(initial.gameId, "recovered");
    controller.endLifetime();
  });

  it("clears private state on lifetime end and ignores late discovery after reconnect", async () => {
    const { api, controller } = harness();
    const late = Promise.withResolvers<ReturnType<typeof snapshot> | null>();
    api.unfinished.mockReturnValueOnce(late.promise);
    controller.connect();
    const signal = api.unfinished.mock.calls[0]![0];
    controller.endLifetime();
    const ended = controller.getSnapshot();
    controller.endLifetime();
    expect(controller.getSnapshot()).toBe(ended);
    expect(signal.aborted).toBe(true);
    controller.connect({ target: { kind: "none" }, snapshot: null, readiness: true });
    late.resolve(snapshot());
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "entry",
      snapshot: null,
      pendingCommand: null,
    });
    expect(api.lifecycle).not.toHaveBeenCalled();
    expect(api.unfinished).toHaveBeenCalledTimes(1);
    controller.endLifetime();
  });

  it("hands a newly created game to navigation without recovering it", async () => {
    const { api } = harness();
    const onGame = vi.fn();
    const controller = new SandboxController(api, undefined, onGame);
    controller.connect({ target: { kind: "none" }, snapshot: null, readiness: true });
    await Promise.resolve();
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      snapshot: { state: "active" },
    });
    expect(onGame).toHaveBeenCalledWith(snapshot().gameId, "created");
    expect(api.snapshot).not.toHaveBeenCalled();
    expect(api.lifecycle).not.toHaveBeenCalled();
    controller.endLifetime();
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: null,
      replay: null,
      pendingCommand: null,
    });
  });

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
    const observed: Pick<SandboxState, "phase" | "snapshot" | "pendingCommand">[] = [];
    const unsubscribe = controller.subscribe(() => observed.push(controller.getSnapshot()));
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
    await controller.retryCommand();
    expect(api.lifecycle.mock.calls[1]?.[0]).toBe(command);
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: paused,
      pendingCommand: null,
      phase: "ready",
    });
    expect(api.bootstrap).not.toHaveBeenCalled();
    const playable = observed.filter(({ phase }) => phase === "ready");
    expect(playable).not.toHaveLength(0);
    for (const state of playable) {
      expect(state).toMatchObject({ snapshot: paused, pendingCommand: null });
    }
    for (const state of observed.filter(({ pendingCommand }) => pendingCommand !== null)) {
      expect(state.snapshot).toBe(initial);
      expect(["recovering", "uncertain", "submitting"]).toContain(state.phase);
    }
    unsubscribe();
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
    for (const version of [1, 2, 3]) {
      api.lifecycle.mockRejectedValueOnce(
        new ApiFailure("api", "GAME_CONFLICT", snapshot(["e2e4"], { version })),
      );
    }
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

  it("does not describe a game completed during recovery as paused", async () => {
    const { api, controller } = harness();
    api.unfinished.mockResolvedValueOnce(snapshot(FOOLS_MATE.slice(0, 3)));
    const completed = snapshot(FOOLS_MATE);
    api.replay.mockResolvedValueOnce(
      gameReplayResponseSchema.parse({ snapshot: completed, initialFen: snapshot().fen }),
    );
    api.lifecycle.mockRejectedValueOnce(new ApiFailure("api", "GAME_CONFLICT", completed));
    await controller.recover();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      snapshot: completed,
      notice: null,
      announcement: { kind: "existing", snapshot: completed },
    });
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
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
    await controller.retryCommand();
    expect(api.lifecycle.mock.calls[1]?.[0]).toBe(original);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      snapshot: { state: "paused" },
    });
  });

  it("opens private URLs and ignores a late response after history navigation", async () => {
    const { api, controller } = harness();
    const late = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.snapshot.mockReturnValueOnce(late.promise);
    const disconnect = controller.connect({ target: { kind: "game", gameId: OTHER_GAME_ID } });
    const paused = snapshot([], { state: "paused", legalMoves: [], version: 3 });
    api.snapshot.mockResolvedValue(paused);
    void controller.enter({ target: { kind: "game", gameId: snapshot().gameId } });
    await vi.waitFor(() => expect(controller.getSnapshot().snapshot).toEqual(paused));
    late.resolve(snapshot([], { gameId: OTHER_GAME_ID }));
    await Promise.resolve();
    expect(controller.getSnapshot().snapshot).toEqual(paused);
    expect(api.bootstrap).not.toHaveBeenCalled();
    disconnect();
  });

  it("treats an invalid game link as lost access without contacting the service", async () => {
    const { api, controller } = harness();
    await controller.enter({ target: { kind: "invalid" } });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "access-error",
      snapshot: null,
      notice: "NOT_FOUND",
    });
    expect(api.snapshot).not.toHaveBeenCalled();
    expect(api.unfinished).not.toHaveBeenCalled();
    expect(api.bootstrap).not.toHaveBeenCalled();
  });
});
