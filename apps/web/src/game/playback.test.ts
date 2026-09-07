import type { ChessColor, GameSnapshot, SessionCredential } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiTurnApi } from "../api/ai";
import { ApiFailure, type SandboxApi } from "../api/client";
import { FOOLS_MATE, OTHER_GAME_ID, snapshot as position } from "../test/fixtures";

import { AiPlaybackController } from "./playback";

const white: SessionCredential = { provider: "openai", apiKey: "white-memory-key" };
const black: SessionCredential = { provider: "anthropic", apiKey: "black-memory-key" };
const controllers: AiPlaybackController[] = [];

function snapshot(
  moves: readonly string[] = [],
  overrides: Partial<GameSnapshot> = {},
): GameSnapshot {
  return position(moves, {
    ...overrides,
    ...(overrides.state && overrides.state !== "active" ? { legalMoves: [] } : {}),
  });
}

function harness(initial = snapshot(), recovered = false, keys = true, humanColor?: ChessColor) {
  const api = {
    ready: vi.fn<SandboxApi["ready"]>().mockResolvedValue(true),
    bootstrap: vi.fn<SandboxApi["bootstrap"]>().mockResolvedValue(),
    create: vi.fn<SandboxApi["create"]>().mockResolvedValue(initial),
    snapshot: vi.fn<SandboxApi["snapshot"]>().mockResolvedValue(initial),
    move: vi.fn<SandboxApi["move"]>(),
    lifecycle: vi.fn<SandboxApi["lifecycle"]>().mockImplementation(async (command) =>
      snapshot([], {
        version: command.expectedVersion + 1,
        ...(command.action === "abort"
          ? { state: "aborted", terminationReason: "aborted" }
          : { state: command.action === "resume" ? "active" : "paused" }),
      }),
    ),
    unfinished: vi.fn<SandboxApi["unfinished"]>().mockResolvedValue(null),
    replay: vi.fn<SandboxApi["replay"]>(),
    pgn: vi.fn<SandboxApi["pgn"]>(),
  };
  const ai = { turn: vi.fn<AiTurnApi["turn"]>() };
  const pending = Promise.withResolvers<GameSnapshot>();
  ai.turn.mockReturnValue(pending.promise);
  const controller = new AiPlaybackController(api, ai, initial, {
    recovered,
    ...(humanColor ? { humanColor } : {}),
    credential: (color) =>
      keys && color !== humanColor ? (color === "white" ? white : black) : null,
  });
  controllers.push(controller);
  controller.connect();
  return { controller, api, ai, pending, initial };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.disconnect());
  vi.useRealTimers();
});

describe("AI versus human controller", () => {
  it("retries the identical uncertain human command before scheduling one AI reply", async () => {
    const { controller, api, ai } = harness(snapshot(), false, true, "white");
    api.move.mockRejectedValueOnce(new ApiFailure("network"));
    await controller.submit("e2e4");
    expect(controller.getSnapshot().game.phase).toBe("uncertain");
    api.move.mockResolvedValueOnce(snapshot(["e2e4"]));
    await Promise.all([controller.retryCommand(), controller.retryCommand()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.move).toHaveBeenCalledTimes(2);
    expect(api.move.mock.calls[1]?.[0]).toEqual(api.move.mock.calls[0]?.[0]);
    expect(ai.turn).toHaveBeenCalledTimes(1);
    expect(ai.turn.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 1 });
  });

  it("pauses and resumes the human turn without requesting an AI move", async () => {
    const { controller, api, ai } = harness(snapshot(), false, true, "white");
    await controller.pause();
    await controller.submit("e2e4");
    await controller.next();
    expect(api.move).not.toHaveBeenCalled();
    expect(controller.canMove()).toBe(false);
    await controller.resume();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ai.turn).not.toHaveBeenCalled();
    expect(controller.canMove()).toBe(true);
    api.move.mockResolvedValueOnce(snapshot(["e2e4"], { version: 3 }));
    await controller.submit("e2e4");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.move.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 2 });
    expect(ai.turn.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 3 });
  });

  it.each(["white", "black"] as const)(
    "completes a game with human %s using only the opponent credential",
    async (humanColor) => {
      const { controller, api, ai } = harness(snapshot(), false, true, humanColor);
      const response = async (command: { expectedVersion: number }) =>
        snapshot(FOOLS_MATE.slice(0, command.expectedVersion + 1));
      api.move.mockImplementation(response);
      ai.turn.mockImplementation(response);
      for (let ply = 0; ply < FOOLS_MATE.length; ply++) {
        const humanTurn = (ply % 2 === 0 ? "white" : "black") === humanColor;
        expect(controller.canMove()).toBe(humanTurn);
        if (humanTurn) {
          await controller.submit(FOOLS_MATE[ply]!);
        } else {
          const humanRequests = api.move.mock.calls.length;
          await controller.submit(FOOLS_MATE[ply]!);
          expect(api.move).toHaveBeenCalledTimes(humanRequests);
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(controller.getSnapshot().game.snapshot?.moves).toHaveLength(ply + 1);
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.getSnapshot()).toMatchObject({
        automatic: false,
        game: { snapshot: { state: "completed", terminationReason: "checkmate", result: "0-1" } },
      });
      expect(controller.canMove()).toBe(false);
      expect(api.move).toHaveBeenCalledTimes(2);
      expect(ai.turn).toHaveBeenCalledTimes(2);
      expect(ai.turn.mock.calls.map(([, credential]) => credential)).toEqual([
        humanColor === "white" ? black : white,
        humanColor === "white" ? black : white,
      ]);
      await controller.submit("a2a3");
      await controller.resign(humanColor);
      expect(api.lifecycle).not.toHaveBeenCalled();
      expect(JSON.stringify(controller.getSnapshot())).not.toContain("memory-key");
    },
  );

  it("waits for the accepted human command and rejects duplicate or out-of-seat moves", async () => {
    const { controller, api, ai, initial } = harness(snapshot(), false, true, "white");
    const accepted = Promise.withResolvers<GameSnapshot>();
    api.move.mockReturnValueOnce(accepted.promise);
    const pending = controller.submit("e2e4");
    await controller.submit("d2d4");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.move).toHaveBeenCalledTimes(1);
    expect(ai.turn).not.toHaveBeenCalled();
    expect(controller.getSnapshot().game.snapshot).toBe(initial);
    expect(controller.canMove()).toBe(false);
    accepted.resolve(snapshot(["e2e4"]));
    await pending;
    await controller.submit("e7e5");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.move).toHaveBeenCalledTimes(1);
    expect(ai.turn).toHaveBeenCalledTimes(1);
    expect(ai.turn.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 1 });
  });

  it.each(["rejected", "uncertain", "conflict"] as const)(
    "does not start AI after a %s human response",
    async (outcome) => {
      const { controller, api, ai } = harness(snapshot(), false, true, "white");
      api.move.mockRejectedValueOnce(
        outcome === "rejected"
          ? new ApiFailure("api", "ILLEGAL_MOVE")
          : outcome === "uncertain"
            ? new ApiFailure("network")
            : new ApiFailure("api", "GAME_CONFLICT", snapshot(["e2e4"])),
      );
      await controller.submit("e2e4");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ai.turn).not.toHaveBeenCalled();
      expect(controller.getSnapshot().automatic).toBe(false);
      expect(controller.canMove()).toBe(false);
    },
  );

  it.each(["white", "black"] as const)(
    "only resigns human %s, including off-turn while AI is pending",
    async (humanColor) => {
      const initial = snapshot(humanColor === "white" ? ["e2e4"] : []);
      const { controller, api, ai, pending } = harness(initial, false, true, humanColor);
      await vi.advanceTimersByTimeAsync(0);
      await controller.resign(humanColor === "white" ? "black" : "white");
      expect(api.lifecycle).not.toHaveBeenCalled();
      const resigned = snapshot(
        initial.moves.map(({ uci }) => uci),
        {
          state: "completed",
          terminationReason: "human_resignation",
          result: humanColor === "white" ? "0-1" : "1-0",
          version: initial.version + 1,
        },
      );
      api.lifecycle.mockResolvedValueOnce(resigned);
      await controller.resign(humanColor);
      expect(api.lifecycle.mock.calls[0]?.[0]).toMatchObject({
        action: "resign",
        losingColor: humanColor,
        expectedVersion: initial.version,
      });
      expect(ai.turn.mock.calls[0]?.[2].aborted).toBe(true);
      pending.resolve(snapshot(["e2e4", "e7e5"]));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.getSnapshot().game.snapshot).toEqual(resigned);
      expect(ai.turn).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps human moves blocked while paused, recovered without keys, or observing AI seats", async () => {
    for (const setup of [
      harness(snapshot([], { state: "paused" }), false, true, "white"),
      harness(snapshot([], { state: "paused" }), true, false, "white"),
      harness(),
    ]) {
      await setup.controller.submit("e2e4");
      expect(setup.controller.canMove()).toBe(false);
      expect(setup.api.move).not.toHaveBeenCalled();
    }
  });
});

describe("AI playback controller", () => {
  it("rejects a configuring recovery snapshot without issuing lifecycle or provider commands", async () => {
    const { controller, api, ai } = harness(snapshot([], { state: "configuring" }), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().game.phase).toBe("recovery-required");
    expect(api.lifecycle).not.toHaveBeenCalled();
    expect(ai.turn).not.toHaveBeenCalled();
  });
  it("recovers paused after an API restart between turns and requires explicit continuation", async () => {
    const { controller, api, ai, pending } = harness();
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(snapshot(["e2e4"]));
    ai.turn.mockRejectedValueOnce(new ApiFailure("restart"));
    api.snapshot.mockResolvedValueOnce(snapshot(["e2e4"]));
    api.lifecycle.mockResolvedValueOnce(snapshot(["e2e4"], { state: "paused", version: 2 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getSnapshot()).toMatchObject({
      automatic: false,
      activity: "idle",
      game: { phase: "ready", snapshot: { state: "paused", version: 2 } },
    });
    expect(ai.turn).toHaveBeenCalledTimes(2);
    api.lifecycle.mockResolvedValueOnce(snapshot(["e2e4"], { version: 3 }));
    ai.turn.mockReturnValue(new Promise(() => undefined));
    await controller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(ai.turn).toHaveBeenCalledTimes(3);
    expect(ai.turn.mock.calls[2]?.[0].expectedVersion).toBe(3);
  });
  it("deduplicates activation and StrictMode reconnect before the first request", async () => {
    const { controller, ai } = harness();
    controller.connect();
    controller.disconnect();
    controller.connect();
    await Promise.all([controller.resume(), controller.resume(), controller.next()]);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([controller.resume(), controller.next()]);
    expect(ai.turn).toHaveBeenCalledTimes(1);
    expect(ai.turn.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 0 });
  });

  it("keeps the accepted board through delayed responses and paces only after acceptance", async () => {
    const { controller, ai, pending, initial } = harness();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ai.turn).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      activity: "thinking",
      game: { snapshot: initial },
    });
    expect(controller.getSnapshot().game.snapshot).toBe(initial);
    controller.setSpeed(2);
    const second = Promise.withResolvers<GameSnapshot>();
    ai.turn.mockReturnValueOnce(second.promise);
    pending.resolve(snapshot(["e2e4"], { version: 7 }));
    await vi.advanceTimersByTimeAsync(499);
    expect(ai.turn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ai.turn).toHaveBeenCalledTimes(2);
    expect(ai.turn.mock.calls[0]?.[1]).toEqual(white);
    expect(ai.turn.mock.calls[1]?.[1]).toEqual(black);
    expect(ai.turn.mock.calls[1]?.[0]).toMatchObject({ expectedVersion: 7 });
    expect(ai.turn.mock.calls[1]?.[0].commandId).not.toBe(ai.turn.mock.calls[0]?.[0].commandId);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("memory-key");
  });

  it.each(["pause", "stop"] as const)(
    "%s supersedes a thinking turn and ignores a late response",
    async (action) => {
      const { controller, api, ai, pending, initial } = harness();
      await vi.advanceTimersByTimeAsync(0);
      const control = Promise.withResolvers<GameSnapshot>();
      api.lifecycle.mockReturnValueOnce(control.promise);
      const request = controller[action]();
      await controller[action]();
      expect(api.lifecycle).toHaveBeenCalledTimes(1);
      expect(ai.turn.mock.calls[0]?.[2].aborted).toBe(true);
      expect(controller.getSnapshot().game.snapshot).toBe(initial);
      const current = snapshot([], {
        version: 1,
        ...(action === "stop"
          ? { state: "aborted", terminationReason: "aborted" }
          : { state: "paused" }),
      });
      control.resolve(current);
      await request;
      pending.resolve(snapshot(["e2e4"], { version: 99 }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.getSnapshot().game.snapshot).toEqual(current);
      expect(controller.getSnapshot().automatic).toBe(false);
      expect(ai.turn).toHaveBeenCalledTimes(1);
    },
  );

  it("steps once while paused, can pause that step, and resumes automatic turns explicitly", async () => {
    const paused = snapshot([], { state: "paused", version: 5 });
    const { controller, api, ai, pending } = harness(paused);
    await vi.advanceTimersByTimeAsync(0);
    const first = controller.next();
    await controller.next();
    expect(ai.turn).toHaveBeenCalledTimes(1);
    expect(ai.turn.mock.calls[0]?.[0].expectedVersion).toBe(5);
    pending.resolve(snapshot(["e2e4"], { state: "paused", version: 6 }));
    await first;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ai.turn).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().game.snapshot?.state).toBe("paused");
    const second = Promise.withResolvers<GameSnapshot>();
    ai.turn.mockReturnValueOnce(second.promise);
    void controller.next();
    api.lifecycle.mockResolvedValueOnce(snapshot(["e2e4"], { state: "paused", version: 7 }));
    await controller.pause();
    expect(ai.turn.mock.calls[1]?.[2].aborted).toBe(true);
    api.lifecycle.mockResolvedValueOnce(snapshot(["e2e4"], { version: 8 }));
    await Promise.all([controller.resume(), controller.resume()]);
    ai.turn.mockReturnValue(new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(ai.turn).toHaveBeenCalledTimes(3);
    expect(ai.turn.mock.calls[2]?.[0].expectedVersion).toBe(8);
  });

  it.each([
    snapshot(FOOLS_MATE),
    snapshot([], {
      state: "completed",
      result: "0-1",
      terminationReason: "model_technical_loss",
      version: 1,
    }),
    snapshot([], { state: "paused", version: 1 }),
  ])("halts on a terminal result or provider-error pause", async (result) => {
    const { controller, ai, pending } = harness();
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(result);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getSnapshot()).toMatchObject({
      automatic: false,
      game: { snapshot: result },
    });
    expect(ai.turn).toHaveBeenCalledTimes(1);
  });

  it.each(["pause", "stop"] as const)(
    "%s cancels a scheduled next turn and handles a completion winning the lock",
    async (action) => {
      const { controller, ai, api, pending } = harness();
      await vi.advanceTimersByTimeAsync(0);
      pending.resolve(snapshot(["e2e4"]));
      await vi.advanceTimersByTimeAsync(500);
      api.lifecycle.mockRejectedValueOnce(
        new ApiFailure("api", "GAME_CONFLICT", snapshot(["e2e4", "e7e5"])),
      );
      const target = snapshot(["e2e4", "e7e5"], {
        version: 3,
        ...(action === "stop"
          ? { state: "aborted", terminationReason: "aborted" }
          : { state: "paused" }),
      });
      api.lifecycle.mockResolvedValueOnce(target);
      await controller[action]();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ai.turn).toHaveBeenCalledTimes(1);
      expect(api.lifecycle.mock.calls.map(([command]) => command.expectedVersion)).toEqual([1, 2]);
      expect(controller.getSnapshot().game.snapshot).toEqual(target);
    },
  );

  it.each(["conflict", "network"] as const)(
    "keeps a same-version %s uncertain until explicit pause, never resending the turn",
    async (kind) => {
      const { controller, ai, pending, initial } = harness();
      await vi.advanceTimersByTimeAsync(0);
      pending.reject(
        kind === "conflict"
          ? new ApiFailure("api", "GAME_CONFLICT", initial)
          : new ApiFailure("network"),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.getSnapshot()).toMatchObject({
        activity: "uncertain",
        automatic: false,
        game: { snapshot: initial },
      });
      await controller.resume();
      await controller.next();
      await controller.synchronize();
      expect(controller.getSnapshot().activity).toBe("uncertain");
      expect(ai.turn).toHaveBeenCalledTimes(1);
      await controller.pause();
      expect(controller.getSnapshot().activity).toBe("idle");
      ai.turn.mockReturnValue(new Promise(() => undefined));
      void controller.next();
      expect(ai.turn).toHaveBeenCalledTimes(2);
      expect(ai.turn.mock.calls[1]?.[0].commandId).not.toBe(ai.turn.mock.calls[0]?.[0].commandId);
    },
  );

  it("adopts a newer read-back without continuing or replaying an uncertain request", async () => {
    const { controller, ai, api, pending } = harness();
    api.snapshot.mockResolvedValue(snapshot(["e2e4"]));
    await vi.advanceTimersByTimeAsync(0);
    pending.reject(new ApiFailure("timeout"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getSnapshot()).toMatchObject({
      activity: "idle",
      automatic: false,
      game: { snapshot: snapshot(["e2e4"]) },
    });
    expect(ai.turn).toHaveBeenCalledTimes(1);
  });

  it("recovers a failed paused step with no reservation before permitting a fresh turn", async () => {
    const initial = snapshot(["e2e4"], { state: "paused", version: 5 });
    const recovered = snapshot(["e2e4"], { state: "paused", version: 6 });
    const { controller, api, ai } = harness(initial);
    ai.turn.mockRejectedValueOnce(new ApiFailure("network"));
    await controller.next();
    expect(controller.getSnapshot().activity).toBe("uncertain");
    const recovery = Promise.withResolvers<GameSnapshot>();
    api.lifecycle.mockReturnValueOnce(recovery.promise);
    const pause = controller.pause();
    await vi.advanceTimersByTimeAsync(0);
    await controller.pause();
    await controller.resume();
    await controller.next();
    expect(api.lifecycle.mock.calls.map(([command]) => command.action)).toEqual(["pause"]);
    expect(controller.getSnapshot()).toMatchObject({
      automatic: false,
      control: "pause",
      game: { snapshot: initial },
    });
    recovery.resolve(recovered);
    await pause;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getSnapshot()).toMatchObject({
      automatic: false,
      activity: "idle",
      game: { phase: "ready", snapshot: recovered },
    });
    expect(
      api.lifecycle.mock.calls.map(([command]) => [command.action, command.expectedVersion]),
    ).toEqual([["pause", 5]]);
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    expect(ai.turn).toHaveBeenCalledTimes(1);
    ai.turn.mockResolvedValueOnce(snapshot(["e2e4", "e7e5"], { state: "paused", version: 7 }));
    await controller.next();
    expect(ai.turn.mock.calls[1]?.[0].expectedVersion).toBe(6);
    expect(ai.turn.mock.calls[1]?.[0].commandId).not.toBe(ai.turn.mock.calls[0]?.[0].commandId);
    expect(controller.getSnapshot().game.snapshot?.state).toBe("paused");
  });

  it.each(["pause", "stop"] as const)(
    "restores %s after a rejected lifecycle read-back fails, without clearing turn uncertainty",
    async (action) => {
      const initial = snapshot([], { state: "paused", version: 1 });
      const recovered = snapshot([], { state: "paused", version: 2 });
      const stopped = snapshot([], { state: "aborted", terminationReason: "aborted", version: 2 });
      const { controller, api, ai } = harness(initial);
      ai.turn.mockRejectedValueOnce(new ApiFailure("network"));
      await controller.next();
      api.lifecycle.mockRejectedValueOnce(new ApiFailure("api", "INVALID_GAME_STATE"));
      api.snapshot.mockRejectedValueOnce(new ApiFailure("network"));
      await controller.pause();
      expect(controller.getSnapshot().game.phase).toBe("sync-required");
      await controller.synchronize();
      expect(controller.getSnapshot()).toMatchObject({
        activity: "uncertain",
        automatic: false,
        game: { phase: "ready", snapshot: initial, pendingCommand: null },
      });
      await controller.resume();
      await controller.next();
      expect(ai.turn).toHaveBeenCalledTimes(1);
      expect(api.lifecycle).toHaveBeenCalledTimes(1);
      if (action === "pause") {
        api.lifecycle.mockResolvedValueOnce(recovered);
      } else api.lifecycle.mockResolvedValueOnce(stopped);
      await controller[action]();
      expect(controller.getSnapshot()).toMatchObject({
        activity: "idle",
        automatic: false,
        game: { phase: "ready", snapshot: action === "pause" ? recovered : stopped },
      });
      expect(ai.turn).toHaveBeenCalledTimes(1);
    },
  );

  it("does not discard a pending lifecycle command on a same-version AI synchronization", async () => {
    const initial = snapshot([], { state: "paused", version: 1 });
    const { controller, api, ai } = harness(initial);
    ai.turn.mockRejectedValueOnce(new ApiFailure("network"));
    await controller.next();
    api.lifecycle.mockRejectedValueOnce(new ApiFailure("network"));
    await controller.pause();
    const pendingCommand = controller.getSnapshot().game.pendingCommand;
    expect(pendingCommand).toMatchObject({ action: "pause" });
    await controller.synchronize();
    expect(controller.getSnapshot()).toMatchObject({
      activity: "uncertain",
      game: { phase: "uncertain", pendingCommand },
    });
    await controller.pause();
    await controller.stop();
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
  });

  it.each(["active", "paused"] as const)(
    "retains an uncertain recovery Pause from %s for an identical explicit retry",
    async (state) => {
      const initial = snapshot([], { state, version: 1 });
      const recovered = snapshot([], { state: "paused", version: 2 });
      const { controller, api, ai } = harness(initial, false, false);
      api.lifecycle.mockRejectedValueOnce(new ApiFailure("network"));
      await controller.recover();
      const pending = controller.getSnapshot().game.pendingCommand;
      expect(controller.getSnapshot().game).toMatchObject({
        phase: "uncertain",
        snapshot: initial,
        pendingCommand: { action: "pause", expectedVersion: 1 },
      });
      await controller.recover();
      await controller.resume();
      await controller.next();
      expect(api.lifecycle).toHaveBeenCalledTimes(1);
      expect(ai.turn).not.toHaveBeenCalled();
      api.lifecycle.mockRejectedValueOnce(new ApiFailure("api", "GAME_CONFLICT", recovered));
      await controller.retryCommand();
      expect(api.lifecycle.mock.calls[1]?.[0]).toEqual(pending);
      expect(controller.getSnapshot()).toMatchObject({
        automatic: false,
        activity: "idle",
        game: { phase: "ready", snapshot: recovered },
      });
    },
  );

  it("ignores a late paused step after recovery has advanced the revision", async () => {
    const initial = snapshot([], { state: "paused", version: 1 });
    const recovered = snapshot([], { state: "paused", version: 2 });
    const { controller, api, ai, pending } = harness(initial);
    const step = controller.next();
    api.lifecycle.mockResolvedValueOnce(recovered);
    await controller.pause();
    pending.resolve(snapshot(["e2e4"], { state: "paused", version: 99 }));
    await step;
    expect(controller.getSnapshot()).toMatchObject({
      automatic: false,
      activity: "idle",
      game: { phase: "ready", snapshot: recovered },
    });
    expect(ai.turn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "suspends the controlling page between turns or during a call (thinking=%s) and reconnects paused",
    async (thinking) => {
      const { controller, api, ai, pending } = harness();
      await vi.advanceTimersByTimeAsync(0);
      if (!thinking) {
        pending.resolve(snapshot(["e2e4"]));
        await vi.advanceTimersByTimeAsync(0);
      }
      const before = controller.getSnapshot().game.snapshot!;
      controller.suspend();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ai.turn).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot()).toMatchObject({
        automatic: false,
        game: { phase: "recovery-required" },
      });
      api.snapshot.mockResolvedValueOnce(before);
      api.lifecycle.mockResolvedValueOnce(
        snapshot(
          before.moves.map(({ uci }) => uci),
          { state: "paused", version: before.version + 1 },
        ),
      );
      controller.connect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.getSnapshot()).toMatchObject({
        automatic: false,
        activity: "idle",
        game: { phase: "ready", snapshot: { state: "paused", moves: before.moves } },
      });
      expect(api.lifecycle.mock.calls.at(-1)?.[0].action).toBe("pause");
      expect(ai.turn).toHaveBeenCalledTimes(1);
    },
  );

  it("can stop while reconciliation is delayed and ignores that obsolete read", async () => {
    const { controller, api, ai, pending } = harness();
    const read = Promise.withResolvers<GameSnapshot>();
    api.snapshot.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(0);
    pending.reject(new ApiFailure("network"));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().activity).toBe("synchronizing");
    await controller.stop();
    read.resolve(snapshot(["e2e4"], { version: 100 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getSnapshot().game.snapshot?.state).toBe("aborted");
    expect(ai.turn).toHaveBeenCalledTimes(1);
  });

  it.each([snapshot([], { gameId: OTHER_GAME_ID, version: 1 }), snapshot()])(
    "rejects responses for another game or a non-advancing revision",
    async (result) => {
      const { controller, pending, initial } = harness();
      await vi.advanceTimersByTimeAsync(0);
      pending.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.getSnapshot()).toMatchObject({
        activity: "uncertain",
        game: { snapshot: initial },
      });
    },
  );

  it("clears private state after access loss and ignores late work after disconnect", async () => {
    const { controller, ai, pending } = harness();
    await vi.advanceTimersByTimeAsync(0);
    pending.reject(new ApiFailure("api", "UNAUTHORIZED"));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().game).toMatchObject({ phase: "access-error", snapshot: null });
    const other = harness();
    await vi.advanceTimersByTimeAsync(0);
    other.controller.disconnect();
    other.pending.resolve(snapshot(["e2e4"]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(other.controller.getSnapshot()).toMatchObject({
      automatic: false,
      activity: "uncertain",
      game: { snapshot: other.initial },
    });
    expect(ai.turn).toHaveBeenCalledTimes(1);
  });

  it("does not run recovered or credential-less games automatically", async () => {
    const recovered = harness(snapshot([], { state: "paused" }), true);
    const missing = harness(snapshot(), false, false);
    await vi.advanceTimersByTimeAsync(10_000);
    await missing.controller.resume();
    await missing.controller.next();
    expect(recovered.ai.turn).not.toHaveBeenCalled();
    expect(missing.ai.turn).not.toHaveBeenCalled();
  });

  it("keeps disconnected lifecycle reconciliation retryable and ignores its stale read", async () => {
    const { controller, api, ai, initial } = harness();
    const read = Promise.withResolvers<GameSnapshot>();
    api.lifecycle.mockRejectedValueOnce(new ApiFailure("api", "INVALID_GAME_STATE"));
    api.snapshot.mockReturnValueOnce(read.promise);
    const pause = controller.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().game.phase).toBe("synchronizing");
    controller.disconnect();
    controller.connect();
    read.resolve(snapshot(["e2e4"]));
    await pause;
    expect(controller.getSnapshot().game).toMatchObject({
      phase: "sync-required",
      snapshot: initial,
    });
    api.snapshot.mockResolvedValueOnce(snapshot([], { state: "paused", version: 1 }));
    await controller.synchronize();
    expect(controller.getSnapshot().game.phase).toBe("ready");
    expect(ai.turn).not.toHaveBeenCalled();
  });

  it("never resumes progression from a lifecycle response arriving after reconnect", async () => {
    const { controller, api, ai } = harness(snapshot([], { state: "paused" }));
    const resumed = Promise.withResolvers<GameSnapshot>();
    api.lifecycle.mockReturnValueOnce(resumed.promise);
    const resume = controller.resume();
    controller.disconnect();
    controller.connect();
    resumed.resolve(snapshot([], { version: 1 }));
    await resume;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getSnapshot()).toMatchObject({
      automatic: false,
      game: { phase: "uncertain" },
    });
    expect(ai.turn).not.toHaveBeenCalled();
  });
});
