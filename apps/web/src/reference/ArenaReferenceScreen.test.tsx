import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { standardPositionPreview } from "../position/preview";
import { renderLocalized } from "../test/render";

import { ArenaReferenceScreen } from "./ArenaReferenceScreen";
import { createReferenceGame } from "./scenarios";

describe("shared arena reference scenarios", () => {
  it.each([
    { id: "humanHuman", human: "White", models: 0, pause: false, orientation: "white" },
    { id: "aiHuman", human: "White", models: 1, pause: true, orientation: "white" },
    { id: "humanAi", human: "Black", models: 1, pause: true, orientation: "black" },
    { id: "aiAi", human: null, models: 2, pause: true, orientation: "white" },
    { id: "identical", human: null, models: 2, pause: true, orientation: "white" },
  ])("reuses the live arena and replay for $id with only supplied actions", async (scenario) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    renderLocalized(<ArenaReferenceScreen />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Test scenario" }), scenario.id);
    const board = screen.getByRole("grid", { name: "Chessboard" });
    expect(screen.getByRole("region", { name: "Test data" })).toBeVisible();
    expect(board).toHaveAttribute("aria-readonly", "true");
    expect(board).toHaveAttribute("data-fen", createReferenceGame(false).snapshot().fen);
    expect(board).toHaveAttribute("data-orientation", scenario.orientation);
    expect(within(board).getAllByRole("gridcell")).toHaveLength(64);
    expect(screen.queryByRole("button", { name: "Pause" }) !== null).toBe(scenario.pause);
    const resignations = screen.queryAllByRole("button", { name: /^Resign / });
    expect(resignations).toHaveLength(scenario.human ? 1 : 0);
    if (scenario.human) expect(resignations[0]).toHaveTextContent("Resign " + scenario.human);
    expect(screen.queryAllByRole("group", { name: /^(White|Black) commentary$/ })).toHaveLength(
      scenario.models,
    );
    expect(screen.queryAllByRole("group", { name: /^(White|Black) telemetry$/ })).toHaveLength(
      scenario.models,
    );
    expect(screen.queryByRole("tablist") !== null).toBe(scenario.models > 0);
    for (const color of ["White", "Black"]) {
      expect(screen.getByLabelText(`${color} player`)).toBeVisible();
    }
    if (scenario.id === "identical") {
      for (const color of ["White", "Black"]) {
        expect(
          within(screen.getByLabelText(`${color} player`)).getByText(
            /^Model-A-Experimental-LongContext/,
          ),
        ).toBeVisible();
      }
    }
    await user.selectOptions(screen.getByRole("combobox", { name: "Reference state" }), "replay");
    expect(screen.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Game controls" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "First" }));
    expect(screen.getByRole("grid")).toHaveAttribute("data-fen", standardPositionPreview.fen);
    expect(screen.getByText("Ply 0 of 4")).toBeVisible();
    if (scenario.models > 0) {
      expect(screen.getAllByText("No commentary provided")).toHaveLength(scenario.models);
      expect(screen.getAllByText("Unavailable")).toHaveLength(scenario.models * 3);
    }
    await user.click(screen.getByRole("button", { name: "View ply 2: e5" }));
    expect(screen.getByText("Ply 2 of 4")).toBeVisible();
    if (scenario.models > 0 && scenario.id !== "humanAi") {
      expect(screen.getAllByText("No commentary provided").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updates local pause, flip and confirmed human resignation through the shared controls", async () => {
    const user = userEvent.setup();
    renderLocalized(<ArenaReferenceScreen />);
    await user.selectOptions(screen.getByLabelText("Test scenario"), "humanAi");
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Resume" })).toHaveFocus();
    expect(screen.getByText("Game paused · Black to move")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Flip board" }));
    expect(screen.getByRole("grid")).toHaveAttribute("data-orientation", "white");
    await user.click(screen.getByRole("button", { name: "Resign Black" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Confirm resignation" }));
    expect(screen.getByRole("heading", { name: "White wins by resignation" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Replay" })).toBeVisible();
  });
});
