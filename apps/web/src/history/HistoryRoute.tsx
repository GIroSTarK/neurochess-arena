import { useTranslation } from "react-i18next";

import { PublicPage } from "../app/PublicPage";
import { useRequiredAccount } from "../auth/context";

import { GuestHistory, HistoryScreen } from "./HistoryScreen";

export function HistoryRoute() {
  const { t } = useTranslation();
  const { state } = useRequiredAccount();
  return (
    <PublicPage>
      {state.phase === "guest" ? (
        <GuestHistory />
      ) : (
        <HistoryScreen username={state.profile?.username ?? t("account.label")} />
      )}
    </PublicPage>
  );
}
