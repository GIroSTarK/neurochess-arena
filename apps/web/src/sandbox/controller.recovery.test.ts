import { gameReplayResponseSchema } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../api/sandbox-client";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";
import { enterSandbox, harness } from "../test/sandbox-controller";

import { SandboxController } from "./controller";

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
    void controller.enter(entry);
    controller.endLifetime();
    await controller.enter(entry);
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
    void controller.enter({
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

  it("clears private state and ignores late explicit recovery after a new entry", async () => {
    const { api, controller } = harness();
    const paused = snapshot([], { state: "paused", legalMoves: [], version: 1 });
    await enterSandbox(controller, paused);
    const late = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.snapshot.mockReturnValueOnce(late.promise);
    const recovering = controller.recover();
    const signal = api.snapshot.mock.calls[0]![1];
    controller.endLifetime();
    const ended = controller.getSnapshot();
    controller.endLifetime();
    expect(controller.getSnapshot()).toBe(ended);
    expect(signal.aborted).toBe(true);
    await enterSandbox(controller);
    late.resolve(snapshot());
    await recovering;
    expect(controller.getSnapshot()).toMatchObject({
      phase: "entry",
      snapshot: null,
      pendingCommand: null,
    });
    expect(api.lifecycle).not.toHaveBeenCalled();
    expect(api.unfinished).not.toHaveBeenCalled();
    controller.endLifetime();
  });

  it("hands a newly created game to navigation without recovering it", async () => {
    const { api } = harness();
    const onGame = vi.fn();
    const controller = new SandboxController(api, undefined, onGame);
    await enterSandbox(controller);
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

  it("clears a pending recovery on departure and fences its late acknowledgement", async () => {
    const initial = snapshot(["e2e4"]);
    const paused = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 });
    const { api, controller } = harness(initial);
    const obsolete = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.lifecycle.mockReturnValueOnce(obsolete.promise);
    const entering = enterSandbox(controller, initial);
    await vi.waitFor(() => expect(api.lifecycle).toHaveBeenCalledTimes(1));
    controller.endLifetime();
    expect(controller.getSnapshot()).toMatchObject({ snapshot: null, pendingCommand: null });
    await enterSandbox(controller, paused);
    obsolete.resolve(paused);
    await entering;
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: paused,
      pendingCommand: null,
      phase: "ready",
    });
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    expect(api.bootstrap).not.toHaveBeenCalled();
    controller.endLifetime();
  });

  it("adopts a discovered game without bootstrap and requires an explicit resume", async () => {
    const initial = snapshot(["e2e4"], { version: 7 });
    const paused = snapshot(["e2e4"], { state: "paused", version: 8, legalMoves: [] });
    const { api, controller } = harness(initial);
    api.lifecycle.mockResolvedValue(paused);
    await enterSandbox(controller, initial);
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
    controller.endLifetime();
  });

  it("does not write when reopening a paused game and treats anonymous discovery as entry", async () => {
    const paused = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 9 });
    const { api, controller } = harness(paused);
    await enterSandbox(controller, paused);
    expect(api.lifecycle).not.toHaveBeenCalled();
    expect(controller.getSnapshot().snapshot).toEqual(paused);
    const anonymous = harness();
    await enterSandbox(anonymous.controller);
    expect(anonymous.controller.getSnapshot()).toMatchObject({
      phase: "entry",
      snapshot: null,
      notice: null,
    });
    expect(anonymous.api.bootstrap).not.toHaveBeenCalled();
  });

  it("bounds recovery conflict retries and never enables an active recovered board", async () => {
    const { api, controller } = harness();
    for (const version of [1, 2, 3]) {
      api.lifecycle.mockRejectedValueOnce(
        new ApiFailure("api", "GAME_CONFLICT", snapshot(["e2e4"], { version })),
      );
    }
    await enterSandbox(controller, snapshot());
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
    const completed = snapshot(FOOLS_MATE);
    api.replay.mockResolvedValueOnce(
      gameReplayResponseSchema.parse({ snapshot: completed, initialFen: snapshot().fen }),
    );
    api.lifecycle.mockRejectedValueOnce(new ApiFailure("api", "GAME_CONFLICT", completed));
    await enterSandbox(controller, snapshot(FOOLS_MATE.slice(0, 3)));
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
    api.lifecycle.mockRejectedValueOnce(new ApiFailure("timeout"));
    await enterSandbox(controller, snapshot(["e2e4"]));
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

  it("discards an obsolete seeded entry when the game parameter changes", async () => {
    const { api, controller } = harness();
    const first = enterSandbox(controller, snapshot([], { gameId: OTHER_GAME_ID }));
    const paused = snapshot([], { state: "paused", legalMoves: [], version: 3 });
    await enterSandbox(controller, paused);
    await first;
    expect(controller.getSnapshot().snapshot).toEqual(paused);
    expect(api.snapshot).not.toHaveBeenCalled();
    expect(api.lifecycle).not.toHaveBeenCalled();
    controller.endLifetime();
  });

  it("treats an invalid game link as lost access without contacting the service", async () => {
    const { api, controller } = harness();
    await controller.enter({ target: { kind: "invalid" }, snapshot: null, readiness: false });
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
