import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderLocalized } from "../test/render";

import { DetailTabs } from "./detail-tabs";

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

  it.each(["tab", "panel", "panel control"] as const)(
    "restores focus when the selected extension's %s is removed",
    async (target) => {
      const user = userEvent.setup();
      const moves = { id: "moves", label: "Moves", content: <p>Move content</p> };
      const analysis = { id: "analysis", label: "Analysis", content: <p>Analysis content</p> };
      const { rerender } = renderLocalized(
        <DetailTabs
          label="Details"
          tabs={[
            moves,
            analysis,
            { id: "events", label: "Events", content: <input aria-label="Event filter" /> },
          ]}
        />,
      );
      await user.click(screen.getByRole("tab", { name: "Events" }));
      if (target === "panel") screen.getByRole("tabpanel", { name: "Events" }).focus();
      if (target === "panel control") await user.click(screen.getByRole("textbox"));

      rerender(<DetailTabs label="Details" tabs={[moves, analysis]} />);
      const fallback = screen.getByRole("tab", { name: "Moves" });
      expect(fallback).toHaveFocus();
      expect(fallback).toHaveAttribute("aria-selected", "true");
      expect(fallback).toHaveAttribute("tabindex", "0");
      expect(screen.getByRole("tabpanel", { name: "Moves" })).toHaveTextContent("Move content");
      await user.keyboard("{ArrowRight}{Enter}");
      expect(screen.getByRole("tab", { name: "Analysis" })).toHaveFocus();
      expect(screen.getByRole("tabpanel", { name: "Analysis" })).toBeVisible();
    },
  );

  it("returns focus to the selected tab when an unselected focused tab is removed", async () => {
    const user = userEvent.setup();
    const moves = { id: "moves", label: "Moves", content: <p>Move content</p> };
    const { rerender } = renderLocalized(
      <DetailTabs
        label="Details"
        tabs={[moves, { id: "events", label: "Events", content: <p>Event content</p> }]}
      />,
    );
    screen.getByRole("tab", { name: "Moves" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Events" })).toHaveFocus();
    rerender(<DetailTabs label="Details" tabs={[moves]} />);
    expect(screen.getByRole("tab", { name: "Moves" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Moves" })).toBeVisible();
  });

  it.each(["outside", "surviving tab", "surviving panel"] as const)(
    "preserves focus on the %s when an extension disappears",
    async (target) => {
      const user = userEvent.setup();
      const moves = { id: "moves", label: "Moves", content: <input aria-label="Move filter" /> };
      const events = { id: "events", label: "Events", content: <p>Event content</p> };
      const { rerender } = renderLocalized(
        <>
          <button type="button">Outside</button>
          <DetailTabs label="Details" tabs={[moves, events]} />
        </>,
      );
      await user.click(screen.getByRole("tab", { name: "Events" }));
      if (target === "outside") await user.click(screen.getByRole("button", { name: "Outside" }));
      else {
        await user.keyboard("{Home}");
        if (target === "surviving panel") {
          await user.keyboard("{Enter}");
          await user.click(screen.getByRole("textbox", { name: "Move filter" }));
        }
      }
      const focused = document.activeElement;

      rerender(
        <>
          <button type="button">Outside</button>
          <DetailTabs label="Details" tabs={[moves]} />
        </>,
      );
      expect(focused).toHaveFocus();
      expect(screen.getByRole("tab", { name: "Moves" })).toHaveAttribute("aria-selected", "true");
    },
  );

  it("does not move focus when the selected panel rerenders", async () => {
    const user = userEvent.setup();
    const moves = { id: "moves", label: "Moves", content: <p>Move content</p> };
    const { rerender } = renderLocalized(
      <DetailTabs
        label="Details"
        tabs={[moves, { id: "events", label: "Events", content: <p>Event content</p> }]}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Events" }));
    rerender(
      <DetailTabs
        label="Details"
        tabs={[moves, { id: "events", label: "Events", content: <p>Updated event content</p> }]}
      />,
    );
    expect(screen.getByRole("tab", { name: "Events" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Events" })).toHaveTextContent(
      "Updated event content",
    );
  });
});
