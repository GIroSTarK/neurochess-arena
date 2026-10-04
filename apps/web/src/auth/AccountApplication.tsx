import { useSyncExternalStore } from "react";
import { Outlet, useFetcher } from "react-router";

import { useAppRoute } from "../app/route-context";

import { AccountContext } from "./context";
import type { AuthActionData } from "./route-data";

export function AccountApplication() {
  const { runtime } = useAppRoute();
  const controller = runtime.account;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const commands = useFetcher<AuthActionData>();
  return (
    <AccountContext value={{ controller, state, commands }}>
      <Outlet />
    </AccountContext>
  );
}
