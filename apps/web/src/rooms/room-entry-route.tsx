import { useTranslation } from "react-i18next";
import { useFetcher, useLoaderData } from "react-router";

import { AccountAccess } from "../auth/account-access";
import { useRequiredAccount } from "../auth/context";
import { AppNavigation } from "../shell/app-navigation";
import { AppShell } from "../shell/app-shell";

import { RoomEntryScreen } from "./room-entry-screen";
import type { RoomEntryData, RoomEntryFeature } from "./route-data";

export function RoomEntryRoute({
  feature,
  mode,
}: {
  readonly feature: RoomEntryFeature;
  readonly mode: "setup" | "join";
}) {
  const { t } = useTranslation();
  const entry = useLoaderData<RoomEntryData | null>();
  const { state } = useRequiredAccount();
  const fetcher = useFetcher();
  const data = entry?.generation === state.revision ? entry.data : null;
  return (
    <AppShell
      mainId="room-entry"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      navigation={<AppNavigation page="rooms" />}
      footer={t("match.private")}
      announcement=""
    >
      {data && entry ? (
        <RoomEntryScreen
          key={entry.generation + mode}
          mode={mode}
          access={data.access}
          existingGameId={data.existingGameId}
          memory={feature.memory}
          onSubmit={(intent, fields) => {
            void fetcher.submit(
              {
                intent,
                ...fields,
                generation: String(entry.generation),
                expectedIdentity: data.expectedIdentity,
              },
              { method: "POST" },
            );
          }}
        />
      ) : (
        <p role="status">{t("routing.loading")}</p>
      )}
    </AppShell>
  );
}
