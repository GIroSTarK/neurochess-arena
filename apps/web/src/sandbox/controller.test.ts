import type { GameErrorCode } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiFailure, type SandboxApi } from "../api";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";

import { SandboxController } from "./controller";

function harness(initial = snapshot()) {
  const api = {
    ready: vi.fn<SandboxApi["ready"]>().mockResolvedValue(true),
    bootstrap: vi.fn<SandboxApi["bootstrap"]>().mockResolvedValue(),
    create: vi.fn<SandboxApi["create"]>().mockResolvedValue(initial),
    snapshot: vi.fn<SandboxApi["snapshot"]>().mockResolvedValue(initial),
    move: vi.fn<SandboxApi["move"]>().mockResolvedValue(snapshot(["e2e4"])),
  };
  const ids = vi.fn(() => crypto.randomUUID());
  const controller = new SandboxController(api, ids);
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
