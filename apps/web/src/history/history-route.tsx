import { PublicPage } from "../app/public-page";
import { useRequiredAccount } from "../auth/context";

import { GuestHistory, HistoryScreen } from "./history-screen";

export function HistoryRoute() {
  const { state } = useRequiredAccount();
  return <PublicPage>{state.phase === "guest" ? <GuestHistory /> : <HistoryScreen />}</PublicPage>;
}
