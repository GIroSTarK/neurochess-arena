import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PROFILE_ID } from "../../analysis/protocol";
import type { EvaluationPly } from "../../gameplay/analysis-controller";
import { initialTarget } from "../../test/analysis";
import { renderLocalized as render } from "../../test/render";

import { EvaluationGraph } from "./evaluation-graph";
import { EvaluationIndicator } from "./evaluation-indicator";

const ready: EvaluationPly = {
  status: "ready",
  saved: "saved",
  sample: {
    ...initialTarget,
    generation: 1,
    depth: 8,
    durationMs: 40,
    score: { kind: "cp", value: 125 },
  },
};

describe("evaluation presentation", () => {
  it("keeps compact score and persistence visible while disclosing provenance", async () => {
    render(<EvaluationIndicator density="compact" state={ready} onRetry={vi.fn()} />);
    expect(screen.getByTestId("evaluation-score")).toHaveTextContent("+1.25 · White advantage");
    expect(screen.getByText("Saved privately")).toBeVisible();
    const details = screen.getByText("Details", { selector: "summary" });
    expect(details.parentElement).not.toHaveAttribute("open");
    expect(screen.getByText(/Depth 8/)).not.toBeVisible();
    await userEvent.click(details);
    expect(screen.getByText(/Depth 8/)).toBeVisible();
    expect(screen.getByText(new RegExp(PROFILE_ID))).toBeVisible();
  });

  it.each([
    { state: undefined, message: "Waiting for analysis…", retry: false },
    {
      state: { status: "computing", saved: "memory" },
      message: "Computing this position…",
      retry: false,
    },
    {
      state: { status: "unavailable", saved: "memory", reason: "engine_load_failed" },
      message: "The analysis engine could not load.",
      retry: true,
    },
    {
      state: { status: "suspended", saved: "memory" },
      message: "Analysis suspended. It resumes after access is checked when this page is visible.",
      retry: false,
      suspended: true,
    },
    { state: { ...ready, saved: "unsaved" }, message: "Not saved", retry: false },
    {
      state: { ...ready, sample: { ...ready.sample!, profileId: "previous-v0" } },
      message: "Older profile · awaiting current analysis",
      retry: false,
    },
    {
      state: ready,
      obsolete: true,
      message: "This analysis profile is obsolete. Reload the page to use the current profile.",
      retry: false,
    },
    {
      state: ready,
      accessError: true,
      message: "Access could not be refreshed. Retry analysis to check access again.",
      retry: true,
    },
    {
      state: {
        ...ready,
        sample: { ...ready.sample!, score: { kind: "mate", winner: "white", moves: 2 } },
      },
      message: "White mates in 2 moves",
      retry: false,
    },
    {
      state: {
        ...ready,
        sample: { ...ready.sample!, score: { kind: "mate", winner: "black", moves: 0 } },
      },
      message: "Black delivered checkmate",
      retry: false,
    },
  ] satisfies {
    state: EvaluationPly | undefined;
    message: string;
    retry: boolean;
    suspended?: boolean;
    obsolete?: boolean;
    accessError?: boolean;
  }[])(
    "keeps compact $message outside the closed disclosure",
    async ({ message, retry, ...props }) => {
      const onRetry = vi.fn();
      render(<EvaluationIndicator density="compact" {...props} onRetry={onRetry} />);
      expect(screen.getByText(message)).toBeVisible();
      expect(screen.getByText(message).closest("details")).toBeNull();
      if (retry) {
        const action = screen.getByRole("button", { name: "Retry analysis" });
        expect(action.closest("details")).toBeNull();
        await userEvent.click(action);
        expect(onRetry).toHaveBeenCalledOnce();
      } else {
        expect(screen.queryByRole("button", { name: "Retry analysis" })).not.toBeInTheDocument();
      }
      const state: EvaluationPly | undefined = props.state;
      if (!state?.sample) expect(screen.queryByTestId("evaluation-score")).not.toBeInTheDocument();
    },
  );

  it.each([
    { state: ready, value: "+1.25 · White advantage" },
    {
      state: { ...ready, sample: { ...ready.sample!, score: { kind: "cp", value: 0 } } },
      value: "0.00 · Equal evaluation",
    },
    {
      state: {
        ...ready,
        sample: { ...ready.sample!, score: { kind: "mate", winner: "black", moves: 0 } },
      },
      value: "Black delivered checkmate",
    },
    { state: { status: "pending", saved: "memory" }, value: "No evaluation yet" },
  ] satisfies { state: EvaluationPly; value: string }[])(
    "exposes the selected position and $value to slider users without a live metric feed",
    ({ state, value }) => {
      const { container, rerender } = render(
        <EvaluationGraph plies={[state, ready]} selectedPly={0} moves={[]} onSelect={vi.fn()} />,
      );
      const slider = screen.getByRole("slider", { name: "Replay position" });
      slider.focus();
      expect(slider).toHaveAttribute("aria-valuetext", `Initial position · Ply 0 · ${value}`);
      expect(screen.getByTestId("evaluation-selected")).toHaveTextContent(
        `Initial position · Ply 0 · ${value}`,
      );
      rerender(
        <EvaluationGraph plies={[ready, ready]} selectedPly={0} moves={[]} onSelect={vi.fn()} />,
      );
      expect(slider).toHaveFocus();
      expect(container.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    },
  );

  it("labels White-relative scores, provenance, depth, memory and pending positions", () => {
    const { rerender } = render(<EvaluationIndicator state={ready} onRetry={vi.fn()} />);
    expect(screen.getByText(/\+1.25/)).toBeVisible();
    expect(screen.getByText(/Depth 8/)).toBeVisible();
    expect(screen.getByText(new RegExp(PROFILE_ID))).toBeVisible();
    rerender(
      <EvaluationIndicator state={{ status: "pending", saved: "memory" }} onRetry={vi.fn()} />,
    );
    expect(screen.queryByText(/\+1.25/)).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for analysis/)).toBeVisible();
  });

  it("keeps unknown and mate scores out of numeric lines and selects the same ply by keyboard", async () => {
    const select = vi.fn();
    const plies: EvaluationPly[] = [
      ready,
      { status: "pending", saved: "memory" },
      {
        ...ready,
        sample: { ...ready.sample!, ply: 2, score: { kind: "mate", winner: "black", moves: 2 } },
      },
      {
        ...ready,
        sample: {
          ...ready.sample!,
          ply: 3,
          profileId: "previous-v0",
          score: { kind: "cp", value: -50 },
        },
      },
    ];
    const { container } = render(
      <EvaluationGraph plies={plies} selectedPly={2} moves={[]} onSelect={select} />,
    );
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
    expect(screen.getAllByText(/Black mates in 2/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByText("Evaluation values", { selector: "summary" }));
    const table = screen.getByRole("table");
    const row = within(table).getByRole("button", { name: /Ply 3/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(select).toHaveBeenCalledWith(3);
    expect(row).toHaveFocus();
    expect(within(table).getByText(/Older profile/)).toBeVisible();
  });

  it("keeps analysis failure recovery separate and shows exact mate-zero as checkmate", async () => {
    const retry = vi.fn();
    const { rerender } = render(
      <EvaluationIndicator
        state={{ status: "unavailable", saved: "unsaved", reason: "engine_load_failed" }}
        onRetry={retry}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry analysis" }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(
      <EvaluationIndicator
        state={{
          ...ready,
          saved: "unsaved",
          sample: { ...ready.sample!, score: { kind: "mate", winner: "black", moves: 0 } },
        }}
        onRetry={retry}
      />,
    );
    expect(screen.getByText("Black delivered checkmate")).toBeVisible();
    expect(screen.getByText("Not saved")).toBeVisible();
  });
});
