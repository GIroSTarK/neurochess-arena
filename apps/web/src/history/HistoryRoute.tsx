import { useTranslation } from "react-i18next";

import { PublicPage } from "../app/PublicPage";
import { useAppRoute } from "../app/route-context";
import { useRequiredAccount } from "../auth/context";

import { GuestHistory, HistoryScreen } from "./HistoryScreen";

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
