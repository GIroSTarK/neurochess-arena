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
});
