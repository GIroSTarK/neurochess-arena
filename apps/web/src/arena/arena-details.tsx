import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { type DetailTab, DetailTabs } from "../ui/detail-tabs";

import { useArenaLayoutMode } from "./layout-mode";

export function ArenaDetails({
  moves,
  commentary,
  telemetry,
  analysis,
  events,
  children,
  initialTab,
}: {
  readonly moves: ReactNode;
  readonly commentary?: ReactNode;
  readonly telemetry?: ReactNode;
  readonly analysis?: ReactNode;
  readonly events?: ReactNode;
  readonly children?: ReactNode;
  readonly initialTab?: string;
}) {
  const { t } = useTranslation();
  const mode = useArenaLayoutMode();
  const [selections, setSelections] = useState({
    wide: initialTab ?? "moves",
    stacked: initialTab ?? "moves",
  });
  const tabs: [DetailTab, ...DetailTab[]] = [
    { id: "moves", label: t("moves.title"), content: moves, scroll: "content" },
  ];
  if (commentary) {
    tabs.push({
      id: "commentary",
      label: t("details.commentary"),
      content: (
        <div className="grid gap-4">
          {commentary}
          {telemetry}
        </div>
      ),
    });
  }
  if (analysis) tabs.push({ id: "analysis", label: t("details.analysis"), content: analysis });
  if (events) tabs.push({ id: "events", label: t("details.events"), content: events });

  return (
    <>
      {!commentary ? telemetry : null}
      {tabs.length > 1 ? (
        <DetailTabs
          label={t("details.label")}
          tabs={tabs}
          selectedTab={selections[mode]}
          onSelectTab={(id) => setSelections((previous) => ({ ...previous, [mode]: id }))}
          pinnedTabIds={mode === "wide" && commentary ? ["commentary"] : []}
        />
      ) : (
        moves
      )}
      {children}
    </>
  );
}
