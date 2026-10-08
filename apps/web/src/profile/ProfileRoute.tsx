import { useLoaderData } from "react-router";

import { PublicPage } from "../app/PublicPage";
import { useAppRoute } from "../app/route-context";
import { useRequiredAccount } from "../auth/context";
import { useRouteAuthEntry } from "../auth/useRouteAuthEntry";

import { ProfileScreen } from "./ProfileScreen";
import type { ProfileRouteData } from "./route-data";

export function ProfileRoute() {
  const { authEntry } = useAppRoute();
  useRequiredAccount();
  const entry = useRouteAuthEntry(authEntry);
  const result = useLoaderData<ProfileRouteData | null>();
  return (
    <PublicPage allowGuest={false} requireProfile={false}>
      {result?.data?.profile ? (
        <ProfileScreen profile={result.data.profile} returnTo={entry.returnTo} />
      ) : null}
    </PublicPage>
  );
}
