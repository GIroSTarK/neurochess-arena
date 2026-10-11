import { useLayoutEffect, useSyncExternalStore } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";

import { createSandboxApi } from "../api/sandbox-client";
import { useGameAnalysis } from "../gameplay/use-game-analysis";
import { useGameRouteController } from "../routing/use-game-route-controller";

import { SandboxController } from "./controller";
import type { SandboxRouteData } from "./route-data";
import type { SandboxState } from "./state";

const analysisPosition = (state: SandboxState) =>
  state.snapshot
    ? {
        snapshot: state.snapshot,
        ply: state.replay ? state.replayPly : state.snapshot.moves.length,
      }
    : null;

export function useSandbox(apiBaseUrl: string) {
  const gameData = useRouteLoaderData<SandboxRouteData>("sandbox-game");
  const setupData = useRouteLoaderData<SandboxRouteData>("sandbox-entry");
  const result = gameData ?? setupData;
  const entry = result?.kind === "entry" ? result.entry : null;
  const revalidator = useRevalidator();
  const { controller, stopped, departing, retry } = useGameRouteController(
    "sandbox",
    (navigation) => new SandboxController(createSandboxApi(apiBaseUrl), undefined, navigation.game),
    (controller) => {
      if (entry) void controller.enter(entry);
    },
    undefined,
    {
      data: result,
      refresh: () => {
        void revalidator.revalidate();
      },
    },
  );
  useLayoutEffect(() => {
    // A fresh access denial also revokes a live or uncertain private view.
    if (
      !stopped &&
      (entry?.issue?.phase === "access-error" || entry?.issue?.phase === "unavailable")
    ) {
      void controller.enter(entry);
    } else if (!stopped && entry?.readiness !== undefined) {
      controller.setReadiness(entry.readiness);
    }
  }, [controller, entry, stopped]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const evaluation = useGameAnalysis(
    controller,
    analysisPosition,
    controller.authorizeAnalysis,
    apiBaseUrl,
  );
  const recover = () => {
    if (entry?.issue && !state.snapshot) retry();
    else void controller.recover();
  };
  const checkReadiness = () => {
    void revalidator.revalidate();
  };
  return { controller, state, stopped, departing, retry, recover, checkReadiness, evaluation };
}
