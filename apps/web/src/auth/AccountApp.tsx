import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { MatchScreen } from "../match/MatchScreen";
import { Button } from "../ui/Button";

import { AccountLayout } from "./AccountLayout";
import { AuthScreen } from "./AuthScreen";
import { createAccountApi } from "./client";
import { AccountContext } from "./context";
import { AccountController } from "./controller";
import { type AuthEntry, authHref, type AuthPage } from "./navigation";
import { ProfileScreen } from "./ProfileScreen";

export function AccountApp({
  apiBaseUrl,
  sandboxEnabled,
  page,
  entry,
  entryRevision,
}: {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
  readonly page: "arena" | "account" | AuthPage;
  readonly entry: AuthEntry;
  readonly entryRevision: number;
}) {
  const { t } = useTranslation();
  const [controller] = useState(() => new AccountController(createAccountApi(apiBaseUrl)));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  return (
    <AccountContext value={{ controller, state }}>
      {page !== "arena" && page !== "account" ? (
        <AuthScreen
          key={`${page}:${entryRevision}`}
          page={page}
          entry={entry}
          sandboxEnabled={sandboxEnabled}
        />
      ) : state.phase === "ready" &&
        state.session &&
        (state.profile?.onboardingRequired || page === "account") ? (
        <ProfileScreen key={state.epoch} sandboxEnabled={sandboxEnabled} />
      ) : state.phase === "ready" && page === "arena" ? (
        <MatchScreen key={state.epoch} apiBaseUrl={apiBaseUrl} sandboxEnabled={sandboxEnabled} />
      ) : (
        <AccountLayout
          title={t(state.phase === "checking" ? "auth.checking" : "auth.account")}
          sandboxEnabled={sandboxEnabled}
        >
          {state.phase !== "checking" ? (
            <>
              <p>{t(state.phase === "error" ? "auth.sessionError" : "auth.sessionEnded")}</p>
              {state.issue ? <p role="alert">{t(`auth.errors.${state.issue}`)}</p> : null}
              <a href={authHref("sign-in")} className="text-accent underline">
                {t("auth.signIn")}
              </a>
              <Button variant="secondary" onClick={() => void controller.check()}>
                {t("auth.retry")}
              </Button>
              <Button variant="quiet" onClick={() => void controller.signOut(true)}>
                {t("auth.guest")}
              </Button>
              {state.phase === "error" ? (
                <Button variant="quiet" onClick={() => void controller.signOut()}>
                  {t("auth.signOut")}
                </Button>
              ) : null}
            </>
          ) : (
            <p role="status">{t("auth.checking")}</p>
          )}
        </AccountLayout>
      )}
    </AccountContext>
  );
}
