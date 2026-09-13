import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderLocalized } from "../test/render";

import { ArenaLayout } from "./ArenaLayout";
import type { PlayerSummaryData } from "./panels/PlayerSummary";

const activity = { label: "Waiting", variants: ["Waiting", "To move"], isTurn: false };

function renderPlayers(white: PlayerSummaryData, black: PlayerSummaryData) {
  return renderLocalized(
    <ArenaLayout
      players={{ white, black }}
      playAreaLabel="Play area"
      detailsLabel="Game details"
      board={<p>Board content</p>}
      details={<p>Game details content</p>}
    />,
  );
}

describe("shared arena composition", () => {
  it("places the entry introduction before play and preserves the board when it is removed", () => {
    const props = {
      players: {
        white: { identity: { kind: "human", name: "Alice" } as const, activity },
        black: { identity: { kind: "human", name: "Bob" } as const, activity },
      },
      playAreaLabel: "Play area",
      detailsLabel: "Game details",
      board: <p>Board content</p>,
      details: <p>Game details content</p>,
    };
    const { rerender } = renderLocalized(
      <ArenaLayout {...props} introduction={<button type="button">Start game</button>} />,
    );
    const introduction = screen.getByRole("button", { name: "Start game" });
    const play = screen.getByRole("region", { name: "Play area" });
    const details = screen.getByRole("complementary", { name: "Game details" });
    const board = within(play).getByText("Board content");
    expect(introduction.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(play.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    rerender(<ArenaLayout {...props} />);
    expect(screen.queryByRole("button", { name: "Start game" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Play area" })).toBe(play);
    expect(within(play).getByText("Board content")).toBe(board);
  });

  it("renders two named humans without assuming a guest identity or model metadata", () => {
    renderPlayers(
      { identity: { kind: "human", name: "Alice" }, activity },
      { identity: { kind: "human", name: "Bob" }, activity },
    );
    expect(within(screen.getByLabelText("White player")).getByText("Alice")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Black player")).getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByText("You · Guest")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Play area" })).toHaveTextContent("Board content");
    expect(screen.getByRole("complementary", { name: "Game details" })).toHaveTextContent(
      "Game details content",
    );
  });

  it("keeps identical long model identities distinguishable by their seats", () => {
    const identity = {
      kind: "ai",
      provider: "Example provider",
      model: "Example model with a deliberately long version and configuration identifier",
    } as const;
    renderPlayers(
      { identity, activity: { ...activity, label: "To move", isTurn: true } },
      { identity, activity },
    );
    for (const color of ["White", "Black"]) {
      const seat = within(screen.getByLabelText(`${color} player`));
      expect(seat.getByText(identity.model)).toBeInTheDocument();
      expect(seat.getByText(identity.provider)).toBeInTheDocument();
    }
    expect(within(screen.getByLabelText("White player")).getByText("To move")).toBeVisible();
    expect(within(screen.getByLabelText("Black player")).getByText("Waiting")).toBeVisible();
  });

  it("renders untrusted model and human names as text in a mixed match", () => {
    const name = '<img src="x" onerror="alert(1)">';
    const model = "<script>untrusted model</script>";
    const { container } = renderPlayers(
      { identity: { kind: "human", name }, activity },
      { identity: { kind: "ai", provider: "Example provider", model }, activity },
    );
    expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText(model)).toBeInTheDocument();
    expect(container.querySelector("img, script")).toBeNull();
    expect(
      within(screen.getByLabelText("White player")).queryByText("Example provider"),
    ).toBeNull();
    expect(
      within(screen.getByLabelText("Black player")).getByText("Example provider"),
    ).toBeVisible();
  });
});
