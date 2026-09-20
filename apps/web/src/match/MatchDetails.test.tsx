import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { invocationRecords, telemetryDetails, viewerCommentary } from "../test/ai-invocations";
import { renderLocalized } from "../test/render";

import { CommentaryPanel } from "./CommentaryPanel";
import { InvocationEvents } from "./InvocationEvents";
import { TelemetryPanel } from "./TelemetryPanel";

describe("minimal Arena telemetry panels", () => {
  it("renders both latest AI moves as plain text, then synchronizes details to replay selection", () => {
    const props = { details: telemetryDetails, records: invocationRecords() };
    const view = renderLocalized(<CommentaryPanel {...props} selectedPly={null} />);
    expect(screen.getByText(viewerCommentary)).toBeVisible();
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText("No commentary provided")).toBeVisible();
    view.rerender(<CommentaryPanel {...props} selectedPly={1} />);
    expect(screen.queryByText("No commentary provided")).not.toBeInTheDocument();
    expect(screen.getByText("300 ms")).toBeVisible();
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
    expect(screen.queryByText("No commentary provided")).not.toBeInTheDocument();
    view.rerender(<CommentaryPanel details={details} records={null} selectedPly={2} />);
    expect(screen.getByText("Move details unavailable.")).toBeVisible();
    expect(screen.getAllByText("Unavailable")).toHaveLength(4);
  });
  it("labels all-attempt totals with independent missing-data coverage and a retryable load error", async () => {
    const onRefresh = vi.fn();
    const props = { details: telemetryDetails, loading: false, error: false, onRefresh };
    const view = renderLocalized(<TelemetryPanel {...props} records={invocationRecords()} />);
    expect(screen.getByText("1,000 ms")).toBeVisible();
    expect(screen.getByText("Recorded attempts: 4")).toBeVisible();
    expect(screen.getByText("Reported for 2 of 4 attempts")).toBeVisible();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
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
