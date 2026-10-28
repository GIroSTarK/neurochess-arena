import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderLocalized } from "../test/render";

import { ArenaDetails } from "./arena-details";
import { ArenaLayoutContext, type ArenaLayoutMode } from "./layout-mode";

describe("arena detail capabilities", () => {
  it("renders only supplied Sandbox content without AI placeholders or single-tab chrome", () => {
    renderLocalized(
      <ArenaDetails moves={<p>Accepted moves</p>}>
        <p>Recovery action</p>
      </ArenaDetails>,
    );
    expect(screen.getByText("Accepted moves")).toBeVisible();
    expect(screen.getByText("Recovery action")).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByText(/Commentary|Analysis|Events|telemetry/)).not.toBeInTheDocument();
  });

  it("defaults stacked AI details to Moves", async () => {
    const user = userEvent.setup();
    renderLocalized(
      <ArenaDetails
        moves={<p>Accepted moves</p>}
        commentary={<p>Commentary slot</p>}
        telemetry={<p>Telemetry slot</p>}
        events={<p>Events slot</p>}
      />,
    );
    expect(screen.getByRole("tabpanel", { name: "Moves" })).toHaveTextContent("Accepted moves");
    expect(screen.queryByRole("tab", { name: "Analysis" })).not.toBeInTheDocument();
    expect(screen.getByText("Commentary slot")).not.toBeVisible();
    expect(screen.getByText("Telemetry slot")).not.toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Commentary" }));
    expect(screen.getByText("Commentary slot")).toBeVisible();
    expect(screen.getByText("Telemetry slot")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByRole("tabpanel", { name: "Events" })).toHaveTextContent("Events slot");
    expect(screen.getByText("Commentary slot")).not.toBeVisible();
  });

  it("restores the wide inspector after compact Commentary", async () => {
    const user = userEvent.setup();
    const details = (mode: ArenaLayoutMode, events = true) => (
      <ArenaLayoutContext value={mode}>
        <ArenaDetails
          moves={<input aria-label="Move filter" />}
          commentary={<input aria-label="Commentary note" />}
          analysis={<p>Analysis slot</p>}
          events={events ? <p>Events slot</p> : undefined}
        />
      </ArenaLayoutContext>
    );
    const { rerender } = renderLocalized(details("wide"));
    await user.type(screen.getByRole("textbox", { name: "Move filter" }), "e4");
    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.queryByRole("tab", { name: "Commentary" })).not.toBeInTheDocument();
    rerender(details("stacked"));
    expect(screen.getByRole("tab", { name: "Moves" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Move filter" })).toHaveValue("e4");
    await user.click(screen.getByRole("tab", { name: "Commentary" }));
    await user.type(screen.getByRole("textbox", { name: "Commentary note" }), "Keep reading");
    rerender(details("wide"));
    expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Commentary note" })).toHaveValue("Keep reading");
    expect(screen.getByRole("textbox", { name: "Commentary note" })).toHaveFocus();
    rerender(details("stacked"));
    expect(screen.getByRole("tab", { name: "Commentary" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    rerender(details("wide", false));
    expect(screen.getByRole("tab", { name: "Moves" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps only one commentary subtree", async () => {
    const user = userEvent.setup();
    const details = (mode: ArenaLayoutMode) => (
      <ArenaLayoutContext value={mode}>
        <ArenaDetails
          moves={<p>Accepted moves</p>}
          commentary={<input aria-label="Reader note" />}
        />
      </ArenaLayoutContext>
    );
    const { rerender, container } = renderLocalized(details("wide"));
    const input = screen.getByRole("textbox");
    await user.type(input, "Saved locally");
    for (const mode of ["stacked", "wide", "stacked"] as const) {
      rerender(details(mode));
      expect(container.querySelectorAll("input")).toHaveLength(1);
      expect(container.querySelector("input")).toBe(input);
      expect(input).toHaveValue("Saved locally");
      if (mode === "stacked") {
        expect(input).not.toBeVisible();
        expect(screen.getByRole("tab", { name: "Moves" })).toHaveFocus();
      }
    }
  });

  it("keeps initialTab compatibility and exposes only Moves and Analysis for human details", () => {
    renderLocalized(
      <ArenaDetails initialTab="analysis" moves={<p>Moves</p>} analysis={<p>Analysis</p>} />,
    );
    expect(screen.getByRole("tab", { name: "Analysis" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });
});
