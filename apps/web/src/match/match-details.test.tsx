import { gameReplayResponseSchema } from "@neurochess/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ArenaDetails } from "../arena/arena-details";
import { ArenaLayoutContext, type ArenaLayoutMode } from "../arena/layout-mode";
import { emptyEvaluation, type EvaluationView } from "../gameplay/analysis-controller";
import { createWebI18n } from "../i18n";
import { invocationRecords, telemetryDetails, viewerCommentary } from "../test/ai-invocations";
import { initialTarget } from "../test/analysis";
import { FOOLS_MATE, snapshot } from "../test/fixtures";
import { renderLocalized } from "../test/render";

import { CommentaryPanel } from "./commentary-panel";
import type { MatchController } from "./controller";
import { InvocationEvents } from "./invocation-events";
import { MatchDetails } from "./panels/match-details";
import { matchPresentation } from "./presentation";
import type { MatchState } from "./state";
import { MatchStore } from "./store";
import { TelemetryPanel } from "./telemetry-panel";

describe("minimal Arena telemetry panels", () => {
  it.each(["wide", "stacked"] as const)(
    "opens terminal Moves in %s and retains the inspector as replay details refresh",
    async (mode) => {
      const user = userEvent.setup();
      const details = { ...telemetryDetails, snapshot: snapshot(FOOLS_MATE) };
      const records = invocationRecords();
      const evaluation: EvaluationView = {
        ...emptyEvaluation,
        gameId: details.snapshot.gameId,
        plies: [0, 1, 2, 3, 4].map((ply) =>
          ply === 2
            ? { status: "unavailable", saved: "memory", reason: "engine_load_failed" }
            : {
                status: "ready",
                saved: "memory",
                sample: {
                  ...initialTarget,
                  ply,
                  generation: 1,
                  depth: 8,
                  durationMs: 40,
                  score:
                    ply === 4
                      ? { kind: "mate", winner: "black", moves: 0 }
                      : { kind: "cp", value: 125 },
                },
              },
        ),
      };
      const controller = {
        selectPly: vi.fn(),
        loadInvocations: vi.fn(),
        newGame: vi.fn(),
      } as unknown as MatchController;
      const renderDetails = (ply: number, loading = false) => {
        const state: MatchState = {
          ...new MatchStore().get(),
          phase: "ready",
          details,
          replay: gameReplayResponseSchema.parse({
            snapshot: details.snapshot,
            initialFen: snapshot().fen,
          }),
          replayPly: ply,
          invocations: records,
          invocationsMoveCount: 4,
          invocationsLoading: loading,
        };
        return (
          <ArenaLayoutContext value={mode}>
            <MatchDetails
              state={state}
              view={matchPresentation(state, createWebI18n().t)}
              controller={controller}
              evaluation={{ view: evaluation, onRetrySave: vi.fn() }}
            />
          </ArenaLayoutContext>
        );
      };
      const { rerender } = renderLocalized(renderDetails(4));
      expect(screen.getByRole("tab", { name: "Moves" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("button", { name: "View ply 4: Qh4#" })).toHaveAttribute(
        "aria-current",
        "step",
      );
      await user.click(screen.getByRole("tab", { name: "Analysis" }));
      expect(screen.getByTestId("evaluation-selected")).toHaveTextContent(
        "Black delivered checkmate",
      );
      const totals = screen.getByRole("region", { name: "Game totals" }).textContent;
      const graph = screen.getByRole("img", { name: /evaluation/i });
      expect(graph.querySelectorAll("polyline")).toHaveLength(1);
      expect(graph.querySelectorAll("circle")).toHaveLength(3);
      expect(within(graph).getByText("M")).toBeInTheDocument();
      for (const ply of [1, 2, 0, 4]) {
        rerender(renderDetails(ply, true));
        expect(screen.getByRole("tab", { name: "Analysis" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(screen.getByTestId("evaluation-marker")).toHaveAttribute("data-ply", String(ply));
        expect(screen.getByRole("region", { name: "Game totals" }).textContent).toBe(totals);
        const commentary = screen.getByRole("region", {
          name: "Commentary & move details",
          hidden: true,
        });
        if (ply === 0) {
          expect(commentary).toHaveTextContent("Initial position · no move selected.");
          expect(commentary).not.toHaveTextContent(viewerCommentary);
        } else if (ply === 1) {
          expect(commentary).toHaveTextContent("White · 1. f3");
          expect(commentary).toHaveTextContent(viewerCommentary);
          expect(screen.getByTestId("evaluation-selected")).toHaveTextContent(
            "+1.25 · White advantage",
          );
        } else if (ply === 2) {
          expect(commentary).toHaveTextContent("Black · 1. e5");
          expect(screen.getByTestId("evaluation-selected")).toHaveTextContent("No evaluation yet");
        }
        expect(screen.getByRole("button", { name: "New game" })).toBeVisible();
      }
    },
  );
  it("retains commentary dialog text and focus across resize", async () => {
    const user = userEvent.setup();
    const renderDetails = (mode: ArenaLayoutMode, updated = false) => (
      <ArenaLayoutContext value={mode}>
        <ArenaDetails
          moves={<p>Accepted moves</p>}
          commentary={
            <CommentaryPanel
              details={
                updated
                  ? { ...telemetryDetails, snapshot: snapshot(["e2e4", "e7e5", "g1f3"]) }
                  : telemetryDetails
              }
              records={invocationRecords()}
              selectedPly={null}
              loading={updated}
            />
          }
          analysis={<p>Analysis content</p>}
        />
      </ArenaLayoutContext>
    );
    const { rerender } = renderLocalized(renderDetails("wide"));
    await user.click(screen.getByRole("button", { name: "Read full commentary: White · 1. e4" }));
    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: "Close commentary" });
    for (const mode of ["stacked", "wide", "stacked"] as const) {
      rerender(renderDetails(mode, true));
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(within(dialog).getByText(viewerCommentary)).toBeVisible();
      expect(close).toHaveFocus();
      await user.keyboard("{Tab}");
      expect(close).toHaveFocus();
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Commentary" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Moves" })).toHaveAttribute("aria-selected", "true");
  });

  it("renders both latest AI moves as plain text, then synchronizes details to replay selection", () => {
    const props = { details: telemetryDetails, records: invocationRecords() };
    const view = renderLocalized(<CommentaryPanel {...props} selectedPly={null} />);
    expect(screen.getByText(viewerCommentary)).toBeVisible();
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText("No commentary provided")).toBeVisible();
    view.rerender(<CommentaryPanel {...props} selectedPly={1} />);
    expect(screen.queryByText("No commentary provided")).not.toBeInTheDocument();
    expect(screen.getByText("300 ms")).toBeVisible();
    expect(screen.getByText("Accepted on attempt 3")).toBeVisible();
    expect(screen.getByText("All-attempt estimate")).toBeVisible();
    expect(screen.getByText("Input tokens")).toBeVisible();
    expect(screen.getByText("Output tokens")).toBeVisible();
    expect(screen.queryByText("Total tokens")).not.toBeInTheDocument();
    expect(screen.queryByText("400 ms")).not.toBeInTheDocument();
    view.rerender(<CommentaryPanel {...props} selectedPly={0} />);
    expect(screen.getByText("Initial position · no move selected.")).toBeVisible();
    expect(screen.queryByText(viewerCommentary)).not.toBeInTheDocument();
  });
  it("distinguishes human moves from missing commentary and missing records", () => {
    const details = {
      ...telemetryDetails,
      configuration: {
        mode: "ai_vs_human" as const,
        seats: {
          white: { type: "human" as const },
          black: telemetryDetails.configuration.seats.black,
        },
      },
    };
    const view = renderLocalized(
      <CommentaryPanel details={details} records={invocationRecords()} selectedPly={1} />,
    );
    expect(screen.getByText("Human move · no model invocation.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Read full commentary/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No commentary provided")).not.toBeInTheDocument();
    view.rerender(<CommentaryPanel details={details} records={null} selectedPly={2} error />);
    expect(screen.getByText("Move details unavailable.")).toBeVisible();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
  });
  it("keeps accepted commentary on its own ply while the next move is waiting for details", () => {
    const records = invocationRecords();
    const next = { ...telemetryDetails, snapshot: snapshot(["e2e4", "e7e5", "g1f3"]) };
    const view = renderLocalized(
      <CommentaryPanel details={next} records={records} selectedPly={null} loading />,
    );
    expect(screen.getByRole("heading", { name: "White · 2. Nf3" })).toBeVisible();
    expect(screen.queryByText(viewerCommentary)).not.toBeInTheDocument();
    expect(screen.getByText("Loading move details…")).toBeVisible();
    expect(screen.getByText("400 ms")).toBeVisible();
    view.rerender(<CommentaryPanel details={next} records={records} selectedPly={1} loading />);
    expect(screen.getByText(viewerCommentary)).toBeVisible();
    expect(screen.getByText("300 ms")).toBeVisible();
  });
  it("opens literal commentary in a dialog, keeps that move during live updates, and restores focus", async () => {
    const user = userEvent.setup();
    const records = invocationRecords();
    const view = renderLocalized(
      <CommentaryPanel details={telemetryDetails} records={records} selectedPly={null} />,
    );
    const trigger = screen.getByRole("button", { name: "Read full commentary: White · 1. e4" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Commentary · White · 1. e4" });
    expect(within(dialog).getByText(viewerCommentary)).toBeVisible();
    expect(dialog.querySelector("img, script, strong")).toBeNull();
    const next = { ...telemetryDetails, snapshot: snapshot(["e2e4", "e7e5", "g1f3"]) };
    view.rerender(<CommentaryPanel details={next} records={records} selectedPly={null} loading />);
    expect(within(dialog).getByText(viewerCommentary)).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    view.rerender(
      <CommentaryPanel details={telemetryDetails} records={records} selectedPly={null} />,
    );
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Close commentary" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("preserves received totals during refresh and labels a failed refresh", () => {
    const next = { ...telemetryDetails, snapshot: snapshot(["e2e4", "e7e5", "g1f3"]) };
    const props = {
      details: next,
      records: invocationRecords(),
      recordedMoveCount: 2,
      onRefresh: vi.fn(),
    };
    const view = renderLocalized(<TelemetryPanel {...props} loading error={false} />);
    expect(screen.getByText("1,000 ms")).toBeVisible();
    expect(screen.getByText("Updating details… Showing the last received data.")).toBeVisible();
    view.rerender(<TelemetryPanel {...props} loading={false} error />);
    expect(screen.getByText("1,000 ms")).toBeVisible();
    expect(
      screen.getByText("Could not refresh details. Showing the last received data."),
    ).toBeVisible();
  });
  it("labels all-attempt totals with independent missing-data coverage and a retryable load error", async () => {
    const onRefresh = vi.fn();
    const props = { details: telemetryDetails, loading: false, error: false, onRefresh };
    const view = renderLocalized(<TelemetryPanel {...props} records={invocationRecords()} />);
    expect(screen.getByText("1,000 ms")).toBeVisible();
    expect(screen.getByText("Recorded attempts: 4")).toBeVisible();
    expect(screen.getByText("Reported for 2 of 4 attempts")).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Game totals" })).getAllByText("Unavailable"),
    ).toHaveLength(4);
    view.rerender(<TelemetryPanel {...props} records={null} error />);
    expect(screen.getByText(/Telemetry could not be loaded/)).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh details" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
  it("shows durable attempt numbers, invalid budget and safe reasons separately", () => {
    renderLocalized(
      <InvocationEvents snapshot={telemetryDetails.snapshot} records={invocationRecords()} />,
    );
    const events = within(screen.getByRole("region", { name: "Invocation events" }));
    expect(events.getByText("Attempt 3 · Move accepted")).toBeVisible();
    expect(events.getByText("Invalid responses: 1 of 3")).toBeVisible();
    expect(events.getByText("The model selected an illegal move.")).toBeVisible();
    expect(events.getByText("The provider reported a quota or rate limit.")).toBeVisible();
    expect(events.queryByText(viewerCommentary)).not.toBeInTheDocument();
  });
});
