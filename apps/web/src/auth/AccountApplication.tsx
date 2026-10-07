import { useEffect, useSyncExternalStore } from "react";
import { Outlet, useFetcher, useLocation } from "react-router";

import { useAppRoute } from "../app/route-context";
import { RouteNotice } from "../app/RouteNotice";

import { AccountContext } from "./context";
import type { AuthActionData } from "./route-data";

export function AccountApplication() {
  const { runtime, sandboxEnabled } = useAppRoute();
  const controller = runtime.account;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const commands = useFetcher<AuthActionData>();
  // Completing onboarding replaces its guarded form before the action finishes
  // broadcasting the profile change and returning its redirect.
  const profileCommands = useFetcher<AuthActionData>();
  const resetProfile = profileCommands.reset;
  const location = useLocation();
  useEffect(() => {
    resetProfile();
  }, [resetProfile, state.revision, location.pathname, location.search]);
  // Stopping observation invalidates account state synchronously, before the
  // pending destination reaches React. That is navigation, not a session check.
  if (runtime.stopped) return <RouteNotice kind="loading" sandboxEnabled={sandboxEnabled} />;
  return (
    <AccountContext value={{ controller, state, commands, profileCommands }}>
      <Outlet />
    </AccountContext>
  );
}
