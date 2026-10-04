import { useEffect, useState, useSyncExternalStore } from "react";

import { createSandboxApi } from "../api/client";
import { appPage, readPathname } from "../app/navigation";

import { SandboxController } from "./controller";
import { browserNavigation } from "./navigation";

/**
 * One controller for the life of the mounted sandbox screen. The API origin comes from the parsed
 * environment and does not change at runtime, so the controller is created once as state rather
 * than memoized: React may discard a memo cache, which would silently replace the session.
 */
export function useSandbox(apiBaseUrl: string) {
  const [navigation] = useState(browserNavigation);
  const [controller] = useState(
    () =>
      new SandboxController(createSandboxApi(apiBaseUrl), undefined, (gameId, reason) =>
        navigation.open(gameId, reason === "recovered"),
      ),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const navigate = () => {
      if (appPage(readPathname()) !== "sandbox") {
        controller.endLifetime();
        return;
      }
      void controller.enter({ target: navigation.read() });
    };
    const pagehide = () => controller.endLifetime();
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) navigate();
    };
    const unsubscribe = navigation.subscribe(navigate);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    navigate();
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("pageshow", pageshow);
      controller.endLifetime();
    };
  }, [controller, navigation]);
  return { controller, state };
}
