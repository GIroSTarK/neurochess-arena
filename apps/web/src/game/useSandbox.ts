import { useSyncExternalStore } from "react";

import { createSandboxApi } from "../api/client";
import { useGameRouteController } from "../app/useGameRouteController";

import { SandboxController } from "./controller";

export function useSandbox(apiBaseUrl: string) {
  const { controller, stopped, retry } = useGameRouteController(
    "sandbox",
    (navigation) => new SandboxController(createSandboxApi(apiBaseUrl), undefined, navigation.game),
    (controller, target) => {
      void controller.enter({ target });
    },
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, state, stopped, retry };
}
