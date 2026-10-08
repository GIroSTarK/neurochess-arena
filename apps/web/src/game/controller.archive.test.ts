import { gameReplayResponseSchema } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiFailure, type SandboxApi } from "../api/sandbox-client";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";
import { enterSandbox, harness } from "../test/sandbox-controller";

import type { PgnDelivery } from "./pgn";
import type { SandboxState } from "./state";

describe("private terminal replay and export", () => {
  async function terminal(initial = snapshot(FOOLS_MATE)) {
    const delivery = {
      copy: vi.fn<PgnDelivery["copy"]>().mockResolvedValue(true),
      download: vi.fn<PgnDelivery["download"]>(),
    };
    const result = harness(initial, undefined, delivery);
    result.api.replay.mockResolvedValue(
      gameReplayResponseSchema.parse({ snapshot: initial, initialFen: snapshot().fen }),
    );
    await enterSandbox(result.controller);
    await result.controller.start();
    await vi.waitFor(() => expect(result.controller.getSnapshot().replay).not.toBeNull());
    return { ...result, delivery };
  }

  // start() shares one catch path for both stages, and retention only asks isTerminal.
  // Keep every stage/failure pair and both terminal states at each stage.
  it.each([
    { state: "completed", stage: "bootstrap", kind: "network" },
    { state: "aborted", stage: "bootstrap", kind: "timeout" },
    { state: "completed", stage: "bootstrap", kind: "malformed" },
    { state: "aborted", stage: "bootstrap", kind: "api" },
    { state: "aborted", stage: "create", kind: "network" },
    { state: "completed", stage: "create", kind: "timeout" },
    { state: "aborted", stage: "create", kind: "malformed" },
    { state: "completed", stage: "create", kind: "api" },
  ] as const)(
    "preserves a $state replay after $stage fails with $kind and allows retry",
    async ({ state, stage, kind }) => {
      const initial =
        state === "completed"
          ? snapshot(FOOLS_MATE)
          : snapshot(["e2e4"], {
              state: "aborted",
              terminationReason: "aborted",
              legalMoves: [],
              version: 2,
            });
      const { api, controller, delivery } = await terminal(initial);
      controller.selectPly(1);
      delivery.copy.mockResolvedValueOnce(false);
      await controller.exportPgn("copy");
      const before = controller.getSnapshot();
      const failure =
        kind === "api" ? new ApiFailure("api", "INTERNAL_SERVER_ERROR") : new ApiFailure(kind);
      if (stage === "bootstrap") api.bootstrap.mockRejectedValueOnce(failure);
      else api.create.mockRejectedValueOnce(failure);

      await controller.start();

      expect(controller.getSnapshot()).toMatchObject({
        phase: "ready",
        snapshot: initial,
        pendingCommand: null,
        replay: before.replay,
        replayPly: 1,
        replayPhase: "idle",
        exportPhase: "manual",
        exportText: initial.pgn,
        notice: failure.code ?? kind,
        announcement: { kind: "notice", notice: failure.code ?? kind },
      });
      expect(api.create).toHaveBeenCalledTimes(stage === "bootstrap" ? 1 : 2);
      const next = snapshot([], { gameId: OTHER_GAME_ID });
      api.create.mockResolvedValueOnce(next);
      await controller.start();
      expect(controller.getSnapshot()).toMatchObject({
        phase: "ready",
        snapshot: next,
        replay: null,
        exportText: null,
        notice: null,
      });
    },
  );

  it.each(
    (["bootstrap", "create"] as const).flatMap((stage) =>
      (["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"] as const).map((code) => ({ stage, code })),
    ),
  )("still clears private terminal state when $stage fails with $code", async ({ stage, code }) => {
    const { api, controller, delivery } = await terminal();
    delivery.copy.mockResolvedValueOnce(false);
    await controller.exportPgn("copy");
    api[stage].mockRejectedValueOnce(new ApiFailure("api", code));
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: null,
      replay: null,
      replayPly: 0,
      exportText: null,
      notice: code === "NOT_FOUND" ? "sandbox-unavailable" : code,
    });
  });

  it("does not restore a terminal game if export loses access while creation is pending", async () => {
    const { api, controller } = await terminal();
    const pending = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.create.mockReturnValueOnce(pending.promise);
    const request = controller.start();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    api.pgn.mockRejectedValueOnce(new ApiFailure("api", "UNAUTHORIZED"));
    await controller.exportPgn("copy");
    pending.reject(new ApiFailure("network"));
    await request;
    expect(controller.getSnapshot()).toMatchObject({
      phase: "access-error",
      snapshot: null,
      replay: null,
      exportText: null,
      notice: "UNAUTHORIZED",
    });
  });

  it.each(
    (["creation", "recovery"] as const).flatMap((operation) =>
      (["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"] as const).map((code) => ({ operation, code })),
    ),
  )("ignores a late $operation success after export reports $code", async ({ operation, code }) => {
    const { api, controller, initial } = await terminal();
    const pending = Promise.withResolvers<ReturnType<typeof snapshot>>();
    if (operation === "creation") api.create.mockReturnValueOnce(pending.promise);
    else api.snapshot.mockReturnValueOnce(pending.promise);
    const request = operation === "creation" ? controller.start() : controller.recover();
    await vi.waitFor(() => {
      if (operation === "creation") expect(api.create).toHaveBeenCalledTimes(2);
      else expect(api.snapshot).toHaveBeenCalledTimes(1);
    });

    api.pgn.mockRejectedValueOnce(new ApiFailure("api", code));
    await controller.exportPgn("copy");
    const cleared = controller.getSnapshot();
    expect(cleared).toMatchObject({ phase: "access-error", snapshot: null, notice: code });
    const observed: SandboxState[] = [];
    const unsubscribe = controller.subscribe(() => observed.push(controller.getSnapshot()));
    pending.resolve(operation === "creation" ? snapshot([], { gameId: OTHER_GAME_ID }) : initial);
    await request;
    unsubscribe();

    expect(controller.getSnapshot()).toBe(cleared);
    expect(observed).toEqual([]);
    expect(api.bootstrap).toHaveBeenCalledTimes(operation === "creation" ? 2 : 1);
    const signal =
      operation === "creation"
        ? api.create.mock.calls.at(-1)?.[0]
        : api.snapshot.mock.calls.at(-1)?.[1];
    expect(signal?.aborted).toBe(true);
  });

  it("lets an in-flight replay finish after New game fails", async () => {
    const { api, controller, initial } = await terminal();
    const pending = Promise.withResolvers<Awaited<ReturnType<SandboxApi["replay"]>>>();
    api.replay.mockReturnValueOnce(pending.promise);
    const replayRequest = controller.loadReplay();
    api.create.mockRejectedValueOnce(new ApiFailure("network"));
    await controller.start();
    expect(api.replay.mock.calls.at(-1)?.[1].aborted).toBe(false);
    pending.resolve(
      gameReplayResponseSchema.parse({ snapshot: initial, initialFen: snapshot().fen }),
    );
    await replayRequest;
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      snapshot: initial,
      replayPhase: "idle",
      replayNotice: null,
    });
  });

  it("allows an explicit restart after access loss without waiting for an obsolete response", async () => {
    const { api, controller, initial } = await terminal();
    const pending = Promise.withResolvers<ReturnType<typeof snapshot>>();
    api.create.mockReturnValueOnce(pending.promise);
    const obsolete = controller.start();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    api.pgn.mockRejectedValueOnce(new ApiFailure("api", "UNAUTHORIZED"));
    await controller.exportPgn("copy");
    expect(api.bootstrap).toHaveBeenCalledTimes(2);

    const next = snapshot([], { gameId: OTHER_GAME_ID });
    api.create.mockResolvedValueOnce(next);
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      snapshot: next,
      notice: null,
    });
    expect(api.bootstrap).toHaveBeenCalledTimes(3);

    pending.resolve(initial);
    await obsolete;
    expect(controller.getSnapshot().snapshot).toBe(next);
    expect(api.replay).toHaveBeenCalledTimes(1);
  });

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

  it.each(["response", "failure"] as const)(
    "clears private replay on departure and ignores its late %s after re-entry",
    async (outcome) => {
      const { api, controller, initial } = await terminal();
      const replay = controller.getSnapshot().replay!;
      const cancelled = Promise.withResolvers<Awaited<ReturnType<SandboxApi["replay"]>>>();
      const retry = Promise.withResolvers<Awaited<ReturnType<SandboxApi["replay"]>>>();
      api.replay.mockReturnValueOnce(cancelled.promise).mockReturnValueOnce(retry.promise);
      const interrupted = controller.loadReplay();
      controller.endLifetime();
      expect(api.replay.mock.calls[1]?.[1].aborted).toBe(true);
      expect(controller.getSnapshot()).toMatchObject({ snapshot: null, replay: null });
      await enterSandbox(controller, initial);
      if (outcome === "response") cancelled.resolve(replay);
      else cancelled.reject(new ApiFailure("cancelled"));
      await interrupted;
      expect(controller.getSnapshot()).toMatchObject({ replay: null, replayPhase: "loading" });
      retry.resolve(replay);
      await vi.waitFor(() => expect(controller.getSnapshot().replay).toEqual(replay));
      expect(controller.getSnapshot().replayPly).toBe(initial.moves.length);
      controller.endLifetime();
    },
  );

  it("restarts a cancelled initial replay on reconnect without accepting its late response", async () => {
    const initial = snapshot(FOOLS_MATE);
    const replay = gameReplayResponseSchema.parse({
      snapshot: initial,
      initialFen: snapshot().fen,
    });
    const { api, controller } = harness(initial);
    const cancelled = Promise.withResolvers<typeof replay>();
    const retry = Promise.withResolvers<typeof replay>();
    api.replay.mockReturnValueOnce(cancelled.promise).mockReturnValueOnce(retry.promise);
    await enterSandbox(controller);
    await controller.start();

    controller.endLifetime();
    expect(api.replay.mock.calls[0]?.[1].aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ replay: null, replayPhase: "idle" });
    await enterSandbox(controller, initial);
    expect(api.replay).toHaveBeenCalledTimes(2);
    cancelled.resolve(replay);
    await cancelled.promise;
    expect(controller.getSnapshot()).toMatchObject({ replay: null, replayPhase: "loading" });

    retry.resolve(replay);
    await vi.waitFor(() => expect(controller.getSnapshot().replayPhase).toBe("idle"));
    expect(controller.getSnapshot()).toMatchObject({ replay, replayPly: initial.moves.length });
    controller.endLifetime();
  });

  it.each(["copy", "download"] as const)(
    "makes interrupted %s export retryable after reconnect and keeps the retry current",
    async (action) => {
      const { api, controller, delivery, initial } = await terminal();
      const cancelled = Promise.withResolvers<Awaited<ReturnType<SandboxApi["pgn"]>>>();
      const retry = Promise.withResolvers<Awaited<ReturnType<SandboxApi["pgn"]>>>();
      api.pgn.mockReturnValueOnce(cancelled.promise).mockReturnValueOnce(retry.promise);
      const interrupted = controller.exportPgn(action);
      expect(controller.getSnapshot().exportPhase).toBe("loading");

      controller.endLifetime();
      expect(api.pgn.mock.calls[0]?.[1].aborted).toBe(true);
      await enterSandbox(controller, initial);
      expect(controller.getSnapshot().exportPhase).toBe("idle");
      expect(api.pgn).toHaveBeenCalledTimes(1);

      const next = controller.exportPgn(action);
      cancelled.reject(new ApiFailure("cancelled"));
      await interrupted;
      expect(controller.getSnapshot().exportPhase).toBe("loading");
      await controller.exportPgn(action);
      expect(api.pgn).toHaveBeenCalledTimes(2);

      retry.resolve({ gameId: initial.gameId, version: initial.version, pgn: initial.pgn });
      await next;
      expect(controller.getSnapshot().exportPhase).toBe(
        action === "copy" ? "copied" : "downloaded",
      );
      expect(delivery[action]).toHaveBeenCalledTimes(1);
      controller.endLifetime();
    },
  );

  it.each(["manual", "error"] as const)(
    "clears settled %s export state and replay selection on departure",
    async (phase) => {
      const { api, controller, delivery, initial } = await terminal();
      if (phase === "manual") delivery.copy.mockResolvedValueOnce(false);
      else api.pgn.mockRejectedValueOnce(new ApiFailure("network"));
      await controller.exportPgn("copy");
      controller.selectPly(1);
      expect(controller.getSnapshot().exportPhase).toBe(phase);
      controller.endLifetime();
      expect(controller.getSnapshot()).toMatchObject({
        snapshot: null,
        replay: null,
        exportText: null,
      });
      await enterSandbox(controller, initial);
      expect(controller.getSnapshot()).toMatchObject({
        exportPhase: "idle",
        exportText: null,
        exportNotice: null,
        replayPly: initial.moves.length,
      });
      expect(api.pgn).toHaveBeenCalledTimes(1);
      expect(api.replay).toHaveBeenCalledTimes(2);
      controller.endLifetime();
    },
  );

  it("rejects mismatched exports and clears all private data on access loss", async () => {
    const { api, controller, delivery, initial } = await terminal();
    api.pgn.mockResolvedValueOnce({
      gameId: initial.gameId,
      version: initial.version + 1,
      pgn: initial.pgn,
    });
    await controller.exportPgn("copy");
    expect(delivery.copy).not.toHaveBeenCalled();
    expect(controller.getSnapshot().exportNotice).toBe("malformed");
    api.pgn.mockRejectedValueOnce(new ApiFailure("api", "UNAUTHORIZED"));
    await controller.exportPgn("download");
    expect(delivery.download).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "access-error",
      snapshot: null,
      replay: null,
      replayNotice: null,
      exportText: null,
      exportNotice: null,
    });
  });

  it("never publishes private replay or manual export text without the accepted game", async () => {
    const { api, controller, delivery, initial } = await terminal();
    delivery.copy.mockResolvedValueOnce(false);
    await controller.exportPgn("copy");
    expect(controller.getSnapshot().exportText).toBe(initial.pgn);
    const observed: SandboxState[] = [];
    const unsubscribe = controller.subscribe(() => observed.push(controller.getSnapshot()));
    api.replay.mockRejectedValueOnce(new ApiFailure("api", "UNAUTHORIZED"));

    await controller.loadReplay();

    const cleared = observed.filter(({ snapshot }) => snapshot === null);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      phase: "access-error",
      pendingCommand: null,
      replay: null,
      replayPly: 0,
      exportPhase: "idle",
      exportText: null,
      announcement: { kind: "notice", notice: "UNAUTHORIZED" },
    });
    unsubscribe();
  });

  it.each(["replay", "export"] as const)(
    "preserves the other archive error while retrying %s",
    async (operation) => {
      const { api, controller } = await terminal();
      api.replay.mockRejectedValueOnce(new ApiFailure("network"));
      api.pgn.mockRejectedValueOnce(new ApiFailure("timeout"));
      await controller.loadReplay();
      await controller.exportPgn("copy");
      expect(controller.getSnapshot()).toMatchObject({
        replayPhase: "error",
        replayNotice: "network",
        exportPhase: "error",
        exportNotice: "timeout",
      });

      const retry = operation === "replay" ? controller.loadReplay() : controller.exportPgn("copy");
      const preserved =
        operation === "replay"
          ? { replayNotice: null, exportPhase: "error", exportNotice: "timeout" }
          : { exportNotice: null, replayPhase: "error", replayNotice: "network" };
      expect(controller.getSnapshot()).toMatchObject({
        ...preserved,
        [`${operation}Phase`]: "loading",
      });
      await retry;
      expect(controller.getSnapshot()).toMatchObject({
        ...preserved,
        [`${operation}Phase`]: operation === "replay" ? "idle" : "copied",
      });
    },
  );

  it("ignores a late replay after export reports lost access", async () => {
    const initial = snapshot(FOOLS_MATE);
    const { api, controller } = harness(initial);
    const late = Promise.withResolvers<Awaited<ReturnType<SandboxApi["replay"]>>>();
    api.replay.mockReturnValue(late.promise);
    await enterSandbox(controller);
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

  it.each([
    { label: "a later revision", replay: snapshot(FOOLS_MATE, { version: 5 }) },
    {
      label: "a different terminal history",
      replay: snapshot(["e2e4", "f7f6", "d2d4", "g7g5", "d1h5"]),
    },
  ])("rejects a replay of $label and keeps the accepted game", async ({ replay }) => {
    const initial = snapshot(FOOLS_MATE);
    const { api, controller } = harness(initial);
    api.replay.mockResolvedValueOnce(
      gameReplayResponseSchema.parse({ snapshot: replay, initialFen: snapshot().fen }),
    );
    await enterSandbox(controller);
    await controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().replayPhase).toBe("error"));
    expect(controller.getSnapshot()).toMatchObject({
      snapshot: initial,
      replay: null,
      replayNotice: "malformed",
    });
    api.replay.mockResolvedValue(
      gameReplayResponseSchema.parse({ snapshot: initial, initialFen: snapshot().fen }),
    );
    await controller.loadReplay();
    expect(controller.getSnapshot()).toMatchObject({ replayPhase: "idle", replayPly: 4 });
  });
});
