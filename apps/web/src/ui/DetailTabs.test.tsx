import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderLocalized } from "../test/render";

import { DetailTabs } from "./DetailTabs";

describe("detail tabs", () => {
  it("moves focus with arrows and Home/End, activates explicitly, and preserves panel state", async () => {
    const user = userEvent.setup();
    renderLocalized(
      <DetailTabs
        label="Details"
        tabs={[
          { id: "moves", label: "Moves", content: <input aria-label="Move filter" /> },
          { id: "analysis", label: "Analysis", content: <p>Analysis content</p> },
          { id: "events", label: "Events", content: <p>Events content</p> },
        ]}
      />,
    );
    await user.type(screen.getByRole("textbox"), "e4");
    const moves = screen.getByRole("tab", { name: "Moves" });
    moves.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Analysis" })).toHaveFocus();
    expect(moves).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Moves" })).toBeVisible();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("tabpanel", { name: "Analysis" })).toHaveTextContent(
      "Analysis content",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.keyboard("{End} ");
    expect(screen.getByRole("tabpanel", { name: "Events" })).toBeVisible();
    await user.keyboard("{ArrowRight}");
    expect(moves).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Events" })).toHaveFocus();
    await user.keyboard("{Home}{Enter}");
    expect(screen.getByRole("textbox", { name: "Move filter" })).toHaveValue("e4");
    expect(
      within(screen.getByRole("tablist"))
        .getAllByRole("tab")
        .filter((tab) => tab.tabIndex === 0),
    ).toEqual([moves]);
  });

  it("returns to the available default when a selected extension is removed", async () => {
    const user = userEvent.setup();
    const moves = { id: "moves", label: "Moves", content: <p>Move content</p> };
    const { rerender } = renderLocalized(
      <DetailTabs
        label="Details"
        tabs={[moves, { id: "events", label: "Events", content: <p>Event content</p> }]}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Events" }));
    rerender(<DetailTabs label="Details" tabs={[moves]} />);
    expect(screen.getByRole("tab", { name: "Moves" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Moves" })).toHaveTextContent("Move content");
  });
});
