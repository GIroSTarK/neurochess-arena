import { useEffect, useMemo, useSyncExternalStore } from "react";

import { createSandboxApi } from "../api/client";

import { SandboxController } from "./controller";
import { browserNavigation } from "./navigation";

export function useSandbox(apiBaseUrl: string) {
  const controller = useMemo(
    () => new SandboxController(createSandboxApi(apiBaseUrl), undefined, browserNavigation()),
    [apiBaseUrl],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  return { controller, state };
}
