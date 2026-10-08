import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderLocalized } from "../test/render";

import { ArenaDetails } from "./arena-details";

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

  it("places commentary and telemetry before opt-in detail tabs with Moves selected by default", async () => {
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
    expect(
      screen
        .getByText("Commentary slot")
        .compareDocumentPosition(screen.getByText("Telemetry slot")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByRole("tabpanel", { name: "Events" })).toHaveTextContent("Events slot");
    expect(screen.getByText("Commentary slot")).toBeVisible();
  });
});
