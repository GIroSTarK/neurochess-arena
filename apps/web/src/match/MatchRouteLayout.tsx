import { useAppRoute } from "../app/route-context";
import { useRequiredAccount } from "../auth/context";

import { MatchRoute } from "./MatchRoute";

export function MatchRouteLayout() {
  const { apiBaseUrl, sandboxEnabled } = useAppRoute();
  const account = useRequiredAccount();
  return (
    <MatchRoute
      key={account.state.revision}
      apiBaseUrl={apiBaseUrl}
      sandboxEnabled={sandboxEnabled}
      identity={account.controller.identity()}
    />
  );
}
