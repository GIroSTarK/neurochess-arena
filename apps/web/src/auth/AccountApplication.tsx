import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { createAuthApi } from "../api/auth-client";
import type { AccountPage } from "../app/navigation";
import type { AuthForm } from "../app/route-urls";
import { CredentialsScreen } from "../credentials/CredentialsScreen";
import { GuestHistory, HistoryScreen } from "../history/HistoryScreen";
import { MatchScreen } from "../match/MatchScreen";
import { Button } from "../ui/Button";

import { AccountFrame } from "./AccountFrame";
import { AuthScreen } from "./AuthScreen";
import { AccountContext } from "./context";
import { AccountController } from "./controller";
import { type AuthEntry, authHref } from "./navigation";
import { ProfileScreen } from "./ProfileScreen";

export function AccountApplication({
  apiBaseUrl,
  sandboxEnabled,
  entry,
  page,
  form = "sign-in",
}: {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
  readonly entry: AuthEntry;
  readonly page: AccountPage;
  readonly form?: AuthForm;
}) {
  const { t } = useTranslation();
  const [controller] = useState(() => new AccountController(createAuthApi(apiBaseUrl)));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  const authPage = page === "auth" || entry.verified || entry.error !== null;
  const credentialPage = page === "credentials";
  const profilePage = page === "profile" || credentialPage;
  const historyPage = page === "history";
  return (
    <AccountContext value={{ controller, state }}>
      {state.deletion === "deleted" && state.phase !== "account" ? (
        <AccountFrame title={t("account.deletion.deleted")} sandboxEnabled={sandboxEnabled}>
          <p role="status">{t("account.deletion.done")}</p>
          <Button
            variant="secondary"
            onClick={() => void controller.chooseGuest().then(() => window.location.assign("/"))}
          >
            {t("account.guest")}
          </Button>
        </AccountFrame>
      ) : authPage ? (
        <AuthScreen key={form} kind={form} entry={entry} sandboxEnabled={sandboxEnabled} />
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
          {state.deletion === "uncertain" ? (
            <p role="alert">{t("account.deletion.uncertain")}</p>
          ) : null}
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
