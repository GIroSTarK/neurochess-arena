import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { createAuthApi } from "../api/auth-client";
import { CredentialsScreen } from "../credentials/CredentialsScreen";
import { GuestHistory, HistoryScreen } from "../history/HistoryScreen";
import { MatchScreen } from "../match/MatchScreen";
import { Button } from "../ui/Button";

import { AccountFrame } from "./AccountFrame";
import { AuthScreen } from "./AuthScreen";
import { AccountContext } from "./context";
import { AccountController } from "./controller";
import { type AuthEntry, authHref, consumeAuthEntry } from "./navigation";
import { ProfileScreen } from "./ProfileScreen";

export function AccountApplication({
  apiBaseUrl,
  sandboxEnabled,
  entry: initialEntry,
}: {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
  readonly entry?: AuthEntry;
}) {
  const { t } = useTranslation();
  const [entry] = useState(() => initialEntry ?? consumeAuthEntry());
  const [controller] = useState(() => new AccountController(createAuthApi(apiBaseUrl)));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  const authPage =
    window.location.pathname.startsWith("/auth/") || entry.verified || entry.error !== null;
  const credentialPage = window.location.pathname === "/account/credentials";
  const profilePage = window.location.pathname === "/account" || credentialPage;
  const historyPage = window.location.pathname === "/history";
  return (
    <AccountContext value={{ controller, state }}>
      {authPage ? (
        <AuthScreen entry={entry} sandboxEnabled={sandboxEnabled} />
      ) : historyPage && state.phase === "guest" ? (
        <GuestHistory sandboxEnabled={sandboxEnabled} />
      ) : state.phase === "account" && credentialPage ? (
        <CredentialsScreen
          key={state.revision}
          apiBaseUrl={apiBaseUrl}
          identity={controller.identity(false)}
          sandboxEnabled={sandboxEnabled}
          returnTo={entry.returnTo}
        />
      ) : state.phase === "account" && (profilePage || !state.profile?.completed) ? (
        <ProfileScreen
          key={state.revision}
          returnTo={entry.returnTo}
          sandboxEnabled={sandboxEnabled}
        />
      ) : historyPage && state.phase === "account" ? (
        <HistoryScreen
          key={state.revision}
          apiBaseUrl={apiBaseUrl}
          identity={controller.identity()}
          username={state.profile?.username ?? t("account.label")}
          sandboxEnabled={sandboxEnabled}
        />
      ) : !profilePage && (state.phase === "guest" || state.phase === "account") ? (
        <MatchScreen
          key={state.revision}
          apiBaseUrl={apiBaseUrl}
          sandboxEnabled={sandboxEnabled}
          identity={controller.identity()}
        />
      ) : (
        <AccountFrame
          title={t(
            state.phase === "required" || (profilePage && state.phase === "guest")
              ? "account.required"
              : state.phase === "unavailable"
                ? "account.unavailable"
                : "account.loading",
          )}
          sandboxEnabled={sandboxEnabled}
        >
          {state.issue ? <p role="alert">{t(`account.errors.${state.issue}`)}</p> : null}
          {state.phase === "required" || state.phase === "guest" ? (
            <>
              <p>{t("account.sessionEnded")}</p>
              <a
                href={authHref("sign-in", entry.returnTo)}
                className="inline-flex min-h-target items-center text-accent underline"
              >
                {t("account.signIn")}
              </a>
              <Button
                variant="secondary"
                onClick={() =>
                  void controller.chooseGuest().then(() => window.location.assign("/"))
                }
              >
                {t("account.guest")}
              </Button>
            </>
          ) : state.phase === "unavailable" ? (
            <Button variant="primary" onClick={() => void controller.refresh()}>
              {t("account.retry")}
            </Button>
          ) : (
            <p role="status">{t("account.working")}</p>
          )}
        </AccountFrame>
      )}
    </AccountContext>
  );
}
