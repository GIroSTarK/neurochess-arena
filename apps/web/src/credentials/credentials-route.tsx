import { PublicPage } from "../app/public-page";
import { useRequiredAccount } from "../auth/context";
import { useRouteAuthEntry } from "../auth/use-route-auth-entry";
import { useAppRoute } from "../routing/route-context";

import { CredentialsScreen } from "./credentials-screen";

export function CredentialsRoute() {
  const { authEntry } = useAppRoute();
  const { controller } = useRequiredAccount();
  const entry = useRouteAuthEntry(authEntry);
  return (
    <PublicPage allowGuest={false} requireProfile={false}>
      <CredentialsScreen identity={controller.identity(false)} returnTo={entry.returnTo} />
    </PublicPage>
  );
}
