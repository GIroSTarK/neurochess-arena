import { useTranslation } from "react-i18next";
import { useLoaderData, useLocation } from "react-router";

import { useAppRoute } from "../app/route-context";
import type { AuthForm } from "../app/route-urls";
import { CredentialsScreen } from "../credentials/CredentialsScreen";
import { GuestHistory, HistoryScreen } from "../history/HistoryScreen";
import { MatchRouteLayout } from "../match/MatchRouteLayout";

import { PublicPage } from "./AccountGuard";
import { AuthScreen } from "./AuthScreen";
import { useRequiredAccount } from "./context";
import { ProfileScreen } from "./ProfileScreen";
import type { ProfileRouteData } from "./route-data";
import { useRouteAuthEntry } from "./useRouteAuthEntry";

export function AuthRoute({ kind }: { readonly kind: AuthForm }) {
  const { sandboxEnabled, authEntry } = useAppRoute();
  const location = useLocation();
  const entry = useRouteAuthEntry(authEntry);
  return (
    <AuthScreen
      key={kind + location.pathname + location.search}
      kind={kind}
      entry={entry}
      sandboxEnabled={sandboxEnabled}
    />
  );
}

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

export function ProfileRoute() {
  const { sandboxEnabled, authEntry } = useAppRoute();
  useRequiredAccount();
  const entry = useRouteAuthEntry(authEntry);
  const result = useLoaderData<ProfileRouteData | null>();
  return (
    <PublicPage allowGuest={false} requireProfile={false}>
      {result?.data?.profile ? (
        <ProfileScreen
          profile={result.data.profile}
          returnTo={entry.returnTo}
          sandboxEnabled={sandboxEnabled}
        />
      ) : null}
    </PublicPage>
  );
}

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

export function HistoryRoute() {
  const { t } = useTranslation();
  const { sandboxEnabled } = useAppRoute();
  const { state } = useRequiredAccount();
  return (
    <PublicPage>
      {state.phase === "guest" ? (
        <GuestHistory sandboxEnabled={sandboxEnabled} />
      ) : (
        <HistoryScreen
          sandboxEnabled={sandboxEnabled}
          username={state.profile?.username ?? t("account.label")}
        />
      )}
    </PublicPage>
  );
}
