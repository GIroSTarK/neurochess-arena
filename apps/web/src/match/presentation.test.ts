import { gameReplayResponseSchema } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { createWebI18n } from "../i18n";
import { FOOLS_MATE, snapshot } from "../test/fixtures";
import { matchDetails } from "../test/match-session";

import { matchPresentation } from "./presentation";
import type { MatchState } from "./state";
import { MatchStore } from "./store";

const t = createWebI18n().t;
function state(overrides: Partial<MatchState> = {}): MatchState {
  return {
    ...new MatchStore().get(),
    phase: "ready",
    details: matchDetails(),
    keys: { white: true, black: true },
    ...overrides,
  };
}

describe("match presentation", () => {
  it.each([
    { human: "white", turn: "white", status: "Your turn · White to move" },
    { human: "black", turn: "black", status: "Your turn · Black to move" },
  ] as const)(
    "presents the $human human seat without AI identity fields",
    ({ human, turn, status }) => {
      const details = { ...matchDetails(human), snapshot: snapshot([], { turn }) };
      const view = matchPresentation(state({ details, canMove: true }), t, "Alex");
      expect(view.human).toBe(human);
      expect(view.header.status?.title).toBe(status);
      expect(view.players[human]).toMatchObject({
        identity: { kind: "human", name: "Alex" },
        activity: { label: "To move", isTurn: true },
      });
      expect(view.players[human === "white" ? "black" : "white"].identity).toEqual({
        kind: "ai",
        provider: "OpenAI",
        model: "fixture",
      });
      expect(view.board?.canMove).toBe(true);
      expect(view.controls.resignation).toEqual({ color: human, disabled: false });
    },
  );

  it("uses the guest name without an account and observes AI-only games", () => {
    expect(
      matchPresentation(state({ details: matchDetails("white") }), t).players.white.identity,
    ).toEqual({ kind: "human", name: "You · Guest" });
    const view = matchPresentation(state({ thinking: true }), t);
    expect(view.header.description).toBe("Observe the match. Both seats are controlled by AI.");
    expect(view.header.status?.title).toBe("White is choosing a move…");
    expect(view.players.white.activity.label).toBe("Choosing a move…");
    expect(view.players.black.activity.label).toBe("Waiting");
    expect(view.controls.resignation).toBeUndefined();
  });

  it.each([
    {
      phase: "recovering",
      busy: true,
      pendingMove: true,
      thinking: true,
      want: "Synchronizing and pausing the game…",
    },
    {
      phase: "ready",
      busy: true,
      pendingMove: true,
      thinking: true,
      want: "Submitting your move…",
    },
    { phase: "ready", busy: true, pendingMove: false, thinking: true, want: "Applying control…" },
    {
      phase: "ready",
      busy: false,
      pendingMove: false,
      thinking: true,
      want: "White is choosing a move…",
    },
    {
      phase: "ready",
      busy: false,
      pendingMove: false,
      thinking: false,
      want: "Waiting for the next move",
    },
  ] as const)("prioritizes status $want", ({ want, ...activity }) => {
    const view = matchPresentation(state(activity), t);
    expect(view.header.status?.title).toBe(want);
    expect(view.header.status?.titleVariants).toContain(want);
  });

  it.each(["white", "black"] as const)("keeps paused %s guidance out of the header", (turn) => {
    const details = {
      ...matchDetails("white"),
      snapshot: snapshot([], { turn, state: "paused", legalMoves: [] }),
    };
    const view = matchPresentation(
      state({ details, issue: { kind: "notice", code: "recovered" } }),
      t,
    );
    expect(view.header.status?.title).toBe("Game paused");
    expect(view.header.status?.pausedLabels).toEqual(["Game paused"]);
    expect(view.details.message).toBe(
      turn === "white"
        ? "Your turn is next. Resume to play your move."
        : "Explore the position. Resume or use Next move.",
    );
    expect(view.announcement).toContain("Re-enter the missing keys");
    expect(view.players[turn].activity).toMatchObject({ label: "Paused", isTurn: false });
    expect(view.controls.canStep).toBe(turn === "black");
  });

  it.each([
    { thinking: true, keys: { white: true, black: true }, phase: "ready" },
    { thinking: false, keys: { white: false, black: true }, phase: "ready" },
    { thinking: false, keys: { white: true, black: true }, phase: "uncertain" },
  ] as const)("gates continuation for thinking, missing keys, and uncertainty: %j", (activity) => {
    const details = {
      ...matchDetails(),
      snapshot: snapshot([], { state: "paused", legalMoves: [] }),
    };
    const view = matchPresentation(state({ details, ...activity }), t);
    expect(view.controls.canContinue).toBe(false);
    expect(view.controls.canStep).toBe(false);
    expect(view.credentials.canContinue).toBe(false);
  });

  it("requires only the AI key to continue a human game", () => {
    const details = {
      ...matchDetails("white"),
      snapshot: snapshot([], { state: "paused", legalMoves: [] }),
    };
    const view = matchPresentation(state({ details, keys: { white: false, black: true } }), t);
    expect(view.controls.canContinue).toBe(true);
    expect(view.controls.canStep).toBe(false);
    expect(view.credentials.paused).toBe(true);
  });

  it("announces the accepted last move while inspecting a separate replay position", () => {
    const terminal = snapshot(FOOLS_MATE);
    const replay = gameReplayResponseSchema.parse({
      snapshot: terminal,
      initialFen: snapshot().fen,
    });
    const view = matchPresentation(
      state({ details: { ...matchDetails(), snapshot: terminal }, replay, replayPly: 0 }),
      t,
    );
    expect(view.board?.snapshot).toBe(terminal);
    expect(view.board?.view?.fen).toBe(replay.initialFen);
    expect(view.board?.interactionEpoch).toBe(`${terminal.gameId}:4:0`);
    expect(view.board?.canMove).toBe(false);
    expect(view.announcement).toBe("Black played Qh4#. Black wins by checkmate ");
    expect(view.header.title).toBe("Black wins by checkmate");
    expect(view.header.status).toBeNull();
    expect(view.header.description).toBe("Review the game with replay and PGN export.");
    expect(view.header.result).toEqual({ score: "0–1", scoreLabel: "Result: 0-1" });
    expect(view.details.message).toBeNull();
    expect(view.players.white.activity).toMatchObject({ label: "View board", isTurn: false });
    expect(view.needsCredentials).toBe(false);
  });

  it.each([
    {
      result: "1/2-1/2",
      state: "completed",
      terminationReason: "stalemate",
      title: "Draw by stalemate",
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
      terminationReason: "model_technical_loss",
      title: "Black wins · Technical loss",
      score: "0–1",
    },
    {
      result: "*",
      state: "aborted",
      terminationReason: "aborted",
      title: "Game stopped",
      score: "*",
    },
  ] as const)("presents $terminationReason without live status", ({ title, score, ...ending }) => {
    const details = { ...matchDetails(), snapshot: snapshot([], { ...ending, legalMoves: [] }) };
    const view = matchPresentation(state({ details }), t);
    expect(view.terminal).toBe(true);
    expect(view.header.title).toBe(title);
    expect(view.header.result?.score).toBe(score);
    expect(view.header.status).toBeNull();
  });

  it("places provider-auth feedback on the rejected seat and other provider failures in its notice", () => {
    const details = {
      ...matchDetails(),
      snapshot: snapshot([], { state: "paused", legalMoves: [] }),
    };
    const auth = matchPresentation(
      state({
        details,
        issue: { kind: "provider", color: "black", error: { code: "provider_auth" } },
      }),
      t,
    );
    expect(auth.credentials.rejectedColor).toBe("black");
    expect(auth.credentials.notice).toBeNull();
    expect(auth.issueText).toBe("Black · This key was rejected. Update it and retry.");
    const quota = matchPresentation(
      state({
        details,
        issue: { kind: "provider", color: "white", error: { code: "provider_quota" } },
      }),
      t,
    );
    expect(quota.credentials.rejectedColor).toBeNull();
    expect(quota.credentials.notice).toBe(
      "White · The provider reported a quota or rate limit. Check your provider account, then retry.",
    );
    expect(quota.details.message).toBe(quota.credentials.notice);
  });

  it("keeps safe request feedback in both the detail rail and live announcement", () => {
    const view = matchPresentation(
      state({ issue: { kind: "request", code: "AI_CONTROLLER_LOST" } }),
      t,
    );
    expect(view.details.message).toBe(
      "This tab lost control. Synchronize and pause before continuing.",
    );
    expect(view.announcement).toContain(view.details.message);
  });

  it("projects no private board or result after access is cleared", () => {
    const view = matchPresentation(
      state({ details: null, phase: "unavailable", issue: { kind: "notice", code: "access" } }),
      t,
    );
    expect(view.board).toBeNull();
    expect(view.header.result).toBeNull();
    expect(view.terminal).toBe(false);
    expect(view.needsCredentials).toBe(false);
    expect(view.announcement).toBe(
      "This private game is unavailable to your session. Keys have been cleared.",
    );
    expect(matchPresentation(state({ details: null, phase: "setup" }), t).needsCredentials).toBe(
      true,
    );
    expect(matchPresentation(new MatchStore().get(), t).announcement).toBe("Opening your game…");
  });
});
