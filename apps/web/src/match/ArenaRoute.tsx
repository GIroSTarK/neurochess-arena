import { PublicPage } from "../app/PublicPage";
import { useAppRoute } from "../app/route-context";
import { AuthRoute } from "../auth/AuthRoute";
import { useRouteAuthEntry } from "../auth/useRouteAuthEntry";

import { MatchRouteLayout } from "./MatchRouteLayout";

export function ArenaRoute() {
  const { authEntry } = useAppRoute();
  const entry = useRouteAuthEntry(authEntry);
  if (entry.verified || entry.error) return <AuthRoute kind="sign-in" />;
  return (
    <PublicPage>
      <MatchRouteLayout />
    </PublicPage>
  );
}
