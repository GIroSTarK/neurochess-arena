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
