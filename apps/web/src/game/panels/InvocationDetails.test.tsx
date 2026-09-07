import type { AiGameConfiguration, GameInvocation } from "@neurochess/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { snapshot } from "../../test/fixtures";
import { renderLocalized } from "../../test/render";

import { InvocationDetails } from "./InvocationDetails";

const match: AiGameConfiguration = {
  mode: "ai_vs_ai",
  white: { provider: "openai", modelId: "same-model", parameters: {} },
  black: { provider: "openai", modelId: "same-model", parameters: {} },
};
const first: GameInvocation = {
  ply: 1,
  color: "white",
  attempt: 2,
  status: "succeeded",
  accepted: true,
  commentary: '<img src=x onerror="alert(1)"> & <script>text</script>',
  error: null,
  latencyMs: 25,
  usage: { inputTokens: 0, outputTokens: 7, totalTokens: null },
};
const invalid: GameInvocation = {
  ...first,
  attempt: 1,
  status: "model_invalid",
  accepted: false,
  commentary: null,
  error: { kind: "model_invalid", reason: "illegal_move" },
};
const second: GameInvocation = {
  ...first,
  ply: 2,
  color: "black",
  attempt: 1,
  commentary: "  ",
  latencyMs: 50,
  usage: { inputTokens: null, outputTokens: null, totalTokens: null },
};
const current = snapshot(["e2e4", "e7e5"], { invocations: [invalid, first, second] });

describe("AI move measurements and history", () => {
  it("keeps identical models' moves separate and renders commentary as inert text", () => {
    const { container } = renderLocalized(<InvocationDetails snapshot={current} match={match} />);
    const white = within(screen.getByRole("article", { name: "Details for ply 1" }));
    const black = within(screen.getByRole("article", { name: "Details for ply 2" }));
    expect(white.getByText(first.commentary!)).toBeVisible();
    expect(white.getByText("25 ms")).toBeVisible();
    expect(white.getByText("0")).toBeVisible();
    expect(white.getByText("7")).toBeVisible();
    expect(white.getByText("Unavailable")).toBeVisible();
    expect(black.getByText("50 ms")).toBeVisible();
    expect(black.getAllByText("Unavailable")).toHaveLength(3);
    expect(black.getByText("No commentary provided")).toBeVisible();
    expect(container.querySelectorAll("img, script")).toHaveLength(0);
    const events = within(screen.getByRole("region", { name: "Attempts and errors" }));
    expect(events.getByText("Illegal move response")).toBeVisible();
    fireEvent.click(events.getByText("Ply 1 · White · Attempt 2"));
    expect(events.getByText(first.commentary!)).toBeVisible();
  });

  it("selects only the replay ply and clears AI measurements on initial and human moves", () => {
    const human: AiGameConfiguration = {
      mode: "ai_vs_human",
      humanColor: "black",
      ai: match.white,
    };
    const state = { ...current, invocations: [invalid, first] };
    const view = renderLocalized(
      <InvocationDetails snapshot={state} match={human} selectedPly={1} />,
    );
    expect(screen.getByRole("article", { name: "Details for ply 1" })).toBeVisible();
    view.rerender(<InvocationDetails snapshot={state} match={human} selectedPly={2} />);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByText("Human move. No model telemetry.")).toBeVisible();
    view.rerender(<InvocationDetails snapshot={state} match={human} selectedPly={0} />);
    expect(screen.getByText("Initial position. No move selected.")).toBeVisible();
    expect(screen.getByText("Illegal move response")).toBeVisible();
  });

  it("shows provider failures and interrupted attempts with unavailable values", () => {
    const entries: GameInvocation[] = [
      {
        ...invalid,
        status: "provider_error",
        error: { kind: "provider_timeout" },
        latencyMs: 120_000,
      },
      {
        ...invalid,
        attempt: 2,
        status: "abandoned",
        error: null,
        latencyMs: null,
        usage: second.usage,
      },
    ];
    renderLocalized(
      <InvocationDetails snapshot={snapshot([], { invocations: entries })} match={match} />,
    );
    expect(screen.getByText("Provider request timed out")).toBeVisible();
    expect(screen.getByText("Interrupted; outcome unavailable")).toBeVisible();
    fireEvent.click(screen.getByText("Ply 1 · White · Attempt 2"));
    expect(
      screen.getAllByText("Unavailable").filter((element) => element.closest("details")?.open),
    ).toHaveLength(4);
  });
});
