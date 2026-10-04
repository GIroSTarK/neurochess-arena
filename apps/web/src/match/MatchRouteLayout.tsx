import { useAppRoute } from "../app/route-context";
import { useRequiredAccount } from "../auth/context";

import { MatchScreen } from "./MatchScreen";

export function MatchRouteLayout() {
  const { apiBaseUrl, sandboxEnabled } = useAppRoute();
  const account = useRequiredAccount();
  return (
    <MatchScreen
      key={account.state.revision}
      apiBaseUrl={apiBaseUrl}
      sandboxEnabled={sandboxEnabled}
      identity={account.controller.identity()}
    />
  );
}
