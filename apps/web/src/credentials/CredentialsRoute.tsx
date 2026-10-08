import { PublicPage } from "../app/PublicPage";
import { useAppRoute } from "../app/route-context";
import { useRequiredAccount } from "../auth/context";
import { useRouteAuthEntry } from "../auth/useRouteAuthEntry";

import { CredentialsScreen } from "./CredentialsScreen";

export function CredentialsRoute() {
  const { sandboxEnabled, authEntry } = useAppRoute();
  const { controller } = useRequiredAccount();
  const entry = useRouteAuthEntry(authEntry);
  return (
    <PublicPage allowGuest={false} requireProfile={false}>
      <CredentialsScreen
        sandboxEnabled={sandboxEnabled}
        identity={controller.identity(false)}
        returnTo={entry.returnTo}
      />
    </PublicPage>
  );
}
