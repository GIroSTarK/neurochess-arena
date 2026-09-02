import { useEffect, useMemo, useSyncExternalStore } from "react";

import { createSandboxApi } from "../api";

import { SandboxController } from "./controller";

export function useSandbox(apiBaseUrl: string) {
  const controller = useMemo(
    () => new SandboxController(createSandboxApi(apiBaseUrl)),
    [apiBaseUrl],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  return { controller, state };
}
