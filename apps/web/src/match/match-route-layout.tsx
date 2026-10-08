import { useRequiredAccount } from "../auth/context";
import { useAppRoute } from "../routing/route-context";

import { MatchRoute } from "./match-route";

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
