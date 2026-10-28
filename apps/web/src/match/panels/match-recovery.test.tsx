import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EvaluationIndicator } from "../../arena/panels/evaluation-indicator";
import { GAME_ID, snapshot } from "../../test/fixtures";
import { createMatchApiFixture } from "../../test/match-api";
import { matchDetails } from "../../test/match-session";
import { renderLocalized } from "../../test/render";
import { MatchController } from "../controller";
import { matchPresentation } from "../presentation";
import type { MatchState } from "../state";

import { MatchDetails } from "./match-details";
import { MatchRecovery } from "./match-recovery";

const controllers: MatchController[] = [];
afterEach(() => controllers.splice(0).forEach((controller) => controller.endLifetime()));

async function harness() {
  const details = {
    ...matchDetails(),
    snapshot: snapshot([], { state: "paused", legalMoves: [] }),
  };
  const { api } = createMatchApiFixture(details);
  const controller = new MatchController(api);
  controllers.push(controller);
  await controller.enter({ kind: "game", gameId: GAME_ID, details });
  return { api, controller };
}

function Host({
  controller,
  override = {},
}: {
  readonly controller: MatchController;
  readonly override?: Partial<MatchState>;
}) {
  const { t } = useTranslation();
  const current = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const state = { ...current, ...override };
  const view = matchPresentation(state, t);
  return (
    <>
      <MatchRecovery state={state} view={view} controller={controller} credentials={[]} />
      <MatchDetails state={state} view={view} controller={controller} />
    </>
  );
}

describe("near-board match recovery", () => {
  it("Keep paused retains keys without a lifecycle request", async () => {
    const { api, controller } = await harness();
    const user = userEvent.setup();
    renderLocalized(<Host controller={controller} />);
    await user.click(screen.getByRole("tab", { name: "Analysis" }));
    const inspector = screen.getByRole("tabpanel", { name: "Analysis" });
    await user.click(screen.getByRole("button", { name: "Restore keys" }));
    await user.type(screen.getByLabelText("White · OpenAI · API key"), "white-fixture");
    await user.type(screen.getByLabelText("Black · OpenAI · API key"), "black-fixture");
    await user.click(screen.getByRole("button", { name: "Keep paused" }));
    expect(screen.getByRole("tabpanel", { name: "Analysis" })).toBe(inspector);
    expect(controller.getSnapshot().keys).toEqual({ white: true, black: true });
    expect(controller.credentials!.require("white", "openai")).toEqual({ apiKey: "white-fixture" });
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    expect(api.lifecycle.mock.calls[0]?.[0]).toMatchObject({ action: "pause" });
    expect(api.turn).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("white-fixture");
  });

  it("routes provider quota to explicit provider continuation without credential replacement", async () => {
    const { controller } = await harness();
    controller.setKey("white", "white-fixture");
    controller.setKey("black", "black-fixture");
    const resume = vi.spyOn(controller, "resume").mockResolvedValue();
    const recover = vi.spyOn(controller, "recover").mockResolvedValue();
    renderLocalized(
      <Host
        controller={controller}
        override={{
          issue: {
            kind: "provider",
            color: "white",
            error: { code: "provider_quota" },
          },
        }}
      />,
    );
    expect(screen.getByText(/White · The provider reported a quota/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restore keys" })).not.toBeInTheDocument();
    expect(resume).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry provider" }));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(["control", "move"] as const)(
    "keeps uncertain %s recovery and identical-command retry separate",
    async (kind) => {
      const { controller } = await harness();
      const resume = vi.spyOn(controller, "resume").mockResolvedValue();
      const recover = vi.spyOn(controller, "recover").mockResolvedValue();
      const retryControl = vi.spyOn(controller, "retryControl").mockResolvedValue();
      const retryMove = vi.spyOn(controller, "retryMove").mockResolvedValue();
      renderLocalized(
        <Host
          controller={controller}
          override={{
            phase: "uncertain",
            pendingControl: kind === "control",
            pendingMove: kind === "move",
            issue: { kind: "notice", code: "uncertain" },
          }}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Synchronize and pause" }));
      expect(recover).toHaveBeenCalledTimes(1);
      await userEvent.click(
        screen.getByRole("button", {
          name: kind === "control" ? "Retry control" : "Retry same move",
        }),
      );
      expect(kind === "control" ? retryControl : retryMove).toHaveBeenCalledTimes(1);
      expect(kind === "control" ? retryMove : retryControl).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Retry provider" })).not.toBeInTheDocument();
    },
  );

  it("keeps analysis retry independent of credential and provider recovery", async () => {
    const { api, controller } = await harness();
    const onRetry = vi.fn();
    renderLocalized(
      <>
        <Host controller={controller} />
        <EvaluationIndicator
          density="compact"
          state={{ status: "unavailable", saved: "memory", reason: "engine_load_failed" }}
          onRetry={onRetry}
        />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry analysis" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(api.lifecycle).toHaveBeenCalledTimes(1);
    expect(api.lifecycle.mock.calls[0]?.[0]).toMatchObject({ action: "pause" });
    expect(api.turn).not.toHaveBeenCalled();
    act(() => controller.endLifetime());
    expect(screen.queryByRole("button", { name: "Restore keys" })).not.toBeInTheDocument();
  });
});
