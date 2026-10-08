import { useEffect, useSyncExternalStore } from "react";
import { Outlet, useFetcher, useLocation } from "react-router";

import { useAppRoute } from "../app/route-context";
import { RouteNotice } from "../app/RouteNotice";

import type { AccountActionData } from "./action-data";
import { AccountContext } from "./context";

export function AccountApplication() {
  const { runtime } = useAppRoute();
  const controller = runtime.account;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const commands = useFetcher<AccountActionData>();
  // Completing onboarding replaces its guarded form before the action finishes
  // broadcasting the profile change and returning its redirect.
  const profileCommands = useFetcher<AccountActionData>();
  const resetProfile = profileCommands.reset;
  const location = useLocation();
  useEffect(() => {
    resetProfile();
  }, [resetProfile, state.revision, location.pathname, location.search]);
  // Stopping observation invalidates account state synchronously, before the
  // pending destination reaches React. That is navigation, not a session check.
  if (runtime.stopped) return <RouteNotice kind="loading" />;
  return (
    <AccountContext value={{ controller, state, commands, profileCommands }}>
      <Outlet />
    </AccountContext>
  );
}
