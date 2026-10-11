import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { estimatedCost, pricedInvocationRecords, telemetryDetails } from "../test/ai-invocations";
import { snapshot } from "../test/fixtures";
import { renderLocalized } from "../test/render";

import { CommentaryPanel } from "./commentary-panel";
import { InvocationEvents } from "./invocation-events";
import { TelemetryPanel } from "./telemetry-panel";

describe("estimated cost views", () => {
  it("shows logical-turn cost alongside accepted-call measurements and follows replay selection", () => {
    const props = { details: telemetryDetails, records: pricedInvocationRecords() };
    const view = renderLocalized(<CommentaryPanel {...props} selectedPly={1} />);
    expect(screen.getByText("All-attempt estimate")).toBeVisible();
    expect(screen.getByText("$0.300000000003")).toBeVisible();
    expect(screen.getByText("300 ms")).toBeVisible();
    view.rerender(<CommentaryPanel {...props} selectedPly={2} />);
    expect(screen.getByText("$0.000000000004")).toBeVisible();
    expect(screen.queryByText("$0.300000000003")).not.toBeInTheDocument();
    view.rerender(<CommentaryPanel {...props} selectedPly={0} />);
    expect(screen.queryByText("$0.000000000004")).not.toBeInTheDocument();
  });

  it("never borrows the previous AI move's estimate while a new move loads", () => {
    const details = { ...telemetryDetails, snapshot: snapshot(["e2e4", "e7e5", "g1f3"]) };
    renderLocalized(
      <CommentaryPanel
        details={details}
        records={pricedInvocationRecords()}
        selectedPly={3}
        loading
      />,
    );
    expect(screen.queryByText("$0.300000000003")).not.toBeInTheDocument();
    expect(screen.getByText("All-attempt estimate")).toBeVisible();
    expect(screen.getByText("Loading move details…")).toBeVisible();
  });

  it("keeps human moves distinct from AI moves whose history is missing", () => {
    const records = { ...pricedInvocationRecords(), turns: [] };
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
      <CommentaryPanel details={details} records={records} selectedPly={1} />,
    );
    expect(screen.getByText("Human move · no model invocation.")).toBeVisible();
    view.rerender(<CommentaryPanel details={details} records={records} selectedPly={2} />);
    expect(screen.getByText("Historical attempts missing")).toBeVisible();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("compares seat colors even when provider and model match, and labels game totals independently of replay", () => {
    const records = pricedInvocationRecords();
    const black = records.turns[1]!.attempts[0]!;
    Object.assign(black, { provider: "openai", modelId: "fixture-white" });
    black.cost = estimatedCost("0.000000000004", black);
    const details = {
      ...telemetryDetails,
      configuration: {
        ...telemetryDetails.configuration,
        seats: {
          white: telemetryDetails.configuration.seats.white,
          black: telemetryDetails.configuration.seats.white,
        },
      },
    };
    renderLocalized(
      <TelemetryPanel
        details={details}
        records={records}
        loading={false}
        error={false}
        onRefresh={vi.fn()}
      />,
    );
    const game = within(screen.getByRole("region", { name: "Game totals" }));
    expect(game.getByText("$0.300000000007")).toBeVisible();
    expect(game.getByText("1,000 ms")).toBeVisible();
    const white = within(screen.getByRole("region", { name: "White totals" }));
    const blackSeat = within(screen.getByRole("region", { name: "Black totals" }));
    expect(white.getByText("$0.300000000003")).toBeVisible();
    expect(blackSeat.getByText("$0.000000000004")).toBeVisible();
    expect(white.getByText("OpenAI · fixture-white")).toBeVisible();
    expect(blackSeat.getByText("OpenAI · fixture-white")).toBeVisible();
  });

  it("explains incomplete cost while preserving known subtotals, independent metrics and attempt details", () => {
    const records = pricedInvocationRecords();
    records.turns[0]!.attempts[1]!.cost = { status: "unavailable", reason: "usage_missing" };
    const view = renderLocalized(
      <TelemetryPanel
        details={telemetryDetails}
        records={records}
        loading={false}
        error={false}
        onRefresh={vi.fn()}
      />,
    );
    const game = within(screen.getByRole("region", { name: "Game totals" }));
    expect(game.getByText("Usage not reported")).toBeVisible();
    expect(game.getByText("Known estimate subtotal: $0.100000000005")).toBeVisible();
    expect(game.getByText("Estimated for 3 of 4 attempts")).toBeVisible();
    expect(game.getByText("1,000 ms")).toBeVisible();
    view.rerender(<InvocationEvents records={records} snapshot={telemetryDetails.snapshot} />);
    expect(screen.getByText("$0.100000000001")).toBeVisible();
    expect(screen.getByText("$0.00")).toBeVisible();
    expect(screen.getByText("Usage not reported")).toBeVisible();
    expect(screen.getAllByText("Input tokens")).toHaveLength(4);
    expect(screen.getAllByText("Output tokens")).toHaveLength(4);
  });

  it("labels an AI seat with no records as unavailable and a human seat as having no AI cost", () => {
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
    renderLocalized(
      <TelemetryPanel
        details={details}
        records={{ ...pricedInvocationRecords(), turns: [] }}
        loading={false}
        error={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "White totals" })).getByText(
        "Human · no AI invocation cost.",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Black totals" })).getByText(
        "Historical attempts missing",
      ),
    ).toBeVisible();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });
});
