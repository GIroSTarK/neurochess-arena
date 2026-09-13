import { useEffect, useState, useSyncExternalStore } from "react";

import { createSandboxApi } from "../api/client";

import { SandboxController } from "./controller";
import { browserNavigation } from "./navigation";

/**
 * One controller for the life of the mounted sandbox screen. The API origin comes from the parsed
 * environment and does not change at runtime, so the controller is created once as state rather
 * than memoized: React may discard a memo cache, which would silently replace the session.
 */
export function useSandbox(apiBaseUrl: string) {
  const [controller] = useState(
    () => new SandboxController(createSandboxApi(apiBaseUrl), undefined, browserNavigation()),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  return { controller, state };
}
