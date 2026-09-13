import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { type DetailTab, DetailTabs } from "../ui/DetailTabs";

export function ArenaDetails({
  moves,
  commentary,
  telemetry,
  analysis,
  events,
  children,
}: {
  readonly moves: ReactNode;
  readonly commentary?: ReactNode;
  readonly telemetry?: ReactNode;
  readonly analysis?: ReactNode;
  readonly events?: ReactNode;
  readonly children?: ReactNode;
}) {
  const { t } = useTranslation();
  const tabs: [DetailTab, ...DetailTab[]] = [
    { id: "moves", label: t("moves.title"), content: moves },
  ];
  if (analysis) tabs.push({ id: "analysis", label: t("details.analysis"), content: analysis });
  if (events) tabs.push({ id: "events", label: t("details.events"), content: events });

  return (
    <>
      {commentary}
      {telemetry}
      {tabs.length > 1 ? <DetailTabs label={t("details.label")} tabs={tabs} /> : moves}
      {children}
    </>
  );
}
