import { useAppRoute } from "../app/route-context";
import { useRequiredAccount } from "../auth/context";

import { MatchRoute } from "./MatchRoute";

export function MatchRouteLayout() {
  const { apiBaseUrl } = useAppRoute();
  const account = useRequiredAccount();
  return (
    <MatchRoute
      key={account.state.revision}
      apiBaseUrl={apiBaseUrl}
      identity={account.controller.identity()}
    />
  );
}
