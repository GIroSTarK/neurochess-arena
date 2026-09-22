import { gameReplayResponseSchema } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { createWebI18n } from "../i18n";
import { FOOLS_MATE, readyState, sandboxState, snapshot } from "../test/fixtures";

import { sandboxPresentation } from "./presentation";

const t = createWebI18n().t;

describe("sandbox presentation boundary", () => {
  it("keeps the complete accepted snapshot separate from a read-only replay position", () => {
    const terminal = snapshot(FOOLS_MATE);
    const replay = gameReplayResponseSchema.parse({
      snapshot: terminal,
      initialFen: snapshot().fen,
    });
    const view = sandboxPresentation(
      readyState({
        snapshot: terminal,
        replayState: { replay, replayPly: 0, replayPhase: "idle", replayNotice: null },
      }),
      t,
    );

    expect(view.board?.snapshot).toBe(terminal);
    expect(view.board?.view?.fen).toBe(replay.initialFen);
    expect(view.board?.canMove).toBe(false);
    expect(view.selectedPly).toBe(0);
    expect(view.moves).toBe(terminal.moves);
    expect(view.terminal).toBe(true);
    expect(view.result).toEqual({
      title: "Black wins by checkmate",
      description: "Sandbox · Game complete · 2... Qh4#",
      score: "0–1",
      scoreLabel: "Result: 0-1",
    });
  });

  it("projects no private board or history after access is cleared", () => {
    const prior = sandboxPresentation(readyState({ snapshot: snapshot(FOOLS_MATE) }), t);
    expect(prior.board).not.toBeNull();
    const cleared = sandboxPresentation(
      sandboxState(
        { phase: "access-error", snapshot: null, pendingCommand: null },
        { notice: "UNAUTHORIZED" },
      ),
      t,
    );
    expect(cleared.board).toBeNull();
    expect(cleared.moves).toEqual([]);
    expect(cleared.selectedPly).toBeUndefined();
    expect(cleared.terminal).toBe(false);
    expect(cleared.startedGameId).toBeNull();
  });

  it("allows input only for a ready active sandbox", () => {
    const active = snapshot();
    expect(sandboxPresentation(readyState({ snapshot: active }), t).board?.canMove).toBe(true);
    const paused = snapshot([], { state: "paused", legalMoves: [] });
    expect(sandboxPresentation(readyState({ snapshot: paused }), t).board?.canMove).toBe(false);
    const uncertain = sandboxState({
      phase: "uncertain",
      snapshot: active,
      pendingCommand: {
        gameId: active.gameId,
        expectedVersion: active.version,
        commandId: crypto.randomUUID(),
        move: "e2e4",
      },
    });
    expect(sandboxPresentation(uncertain, t).board?.canMove).toBe(false);
  });

  it("keeps recovered context while Resume is pending, and clears it after acceptance", () => {
    const paused = snapshot(FOOLS_MATE.slice(0, 3), {
      state: "paused",
      legalMoves: [],
      version: 4,
    });
    const announcement = { kind: "existing", snapshot: paused } as const;
    const restored = sandboxPresentation(
      readyState({ snapshot: paused, notice: "recovered", announcement }),
      t,
    );
    const pending = sandboxPresentation(
      sandboxState(
        {
          phase: "submitting",
          snapshot: paused,
          pendingCommand: {
            action: "resume",
            gameId: paused.gameId,
            expectedVersion: paused.version,
            commandId: crypto.randomUUID(),
          },
        },
        { announcement },
      ),
      t,
    );
    expect(pending.recovery).toEqual(restored.recovery);
    expect(pending.recovery?.title).toBe("Game recovered");
    expect(pending.board?.snapshot).toBe(paused);
    expect(pending.board?.canMove).toBe(false);
    expect(
      sandboxPresentation(
        readyState({ snapshot: snapshot(FOOLS_MATE.slice(0, 3), { version: 5 }) }),
        t,
      ).recovery,
    ).toBeNull();
  });

  it.each([
    {
      result: "1/2-1/2",
      state: "completed",
      terminationReason: "threefold_repetition",
      title: "Draw by threefold repetition",
      score: "½–½",
    },
    {
      result: "1/2-1/2",
      state: "completed",
      terminationReason: "stalemate",
      title: "Draw by stalemate",
      score: "½–½",
    },
    {
      result: "1/2-1/2",
      state: "completed",
      terminationReason: "insufficient_material",
      title: "Draw by insufficient material",
      score: "½–½",
    },
    {
      result: "1/2-1/2",
      state: "completed",
      terminationReason: "fifty_move_rule",
      title: "Draw by the fifty-move rule",
      score: "½–½",
    },
    {
      result: "1-0",
      state: "completed",
      terminationReason: "human_resignation",
      title: "White wins by resignation",
      score: "1–0",
    },
    {
      result: "0-1",
      state: "completed",
      terminationReason: "human_resignation",
      title: "Black wins by resignation",
      score: "0–1",
    },
    {
      result: "*",
      state: "aborted",
      terminationReason: "aborted",
      title: "Game stopped",
      score: "*",
    },
  ] as const)(
    "presents $terminationReason with result $result and its score",
    ({ title, score, ...ending }) => {
      const view = sandboxPresentation(
        readyState({ snapshot: snapshot([], { ...ending, legalMoves: [] }) }),
        t,
      );
      expect(view.result).toMatchObject({ title, score });
      expect(view.result?.description).toBe(
        ending.state === "aborted" ? "Sandbox · Stopped by the owner" : "Sandbox · Game complete",
      );
    },
  );
});
