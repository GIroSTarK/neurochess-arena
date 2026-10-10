import { PublicPage } from "../app/public-page";
import { AuthRoute } from "../auth/auth-route";
import { useRouteAuthEntry } from "../auth/use-route-auth-entry";
import type { RoomEntryFeature } from "../rooms/route-data";
import { useAppRoute } from "../routing/route-context";

import { MatchRouteLayout } from "./match-route-layout";

export function ArenaRoute({ rooms }: { readonly rooms?: RoomEntryFeature | undefined }) {
  const { authEntry } = useAppRoute();
  const entry = useRouteAuthEntry(authEntry);
  if (entry.verified || entry.error) return <AuthRoute kind="sign-in" />;
  return (
    <PublicPage>
      <MatchRouteLayout rooms={rooms} />
    </PublicPage>
  );
}
