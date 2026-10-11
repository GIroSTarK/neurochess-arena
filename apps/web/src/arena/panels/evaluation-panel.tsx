import type { GameSnapshot } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { ENGINE_DIRECTORY, PROFILE_ID } from "../../analysis/protocol";
import type { EvaluationView } from "../../gameplay/analysis-controller";
import { Button } from "../../ui/button";

import { EvaluationGraph } from "./evaluation-graph";

export function EvaluationPanel({
  view,
  selectedPly,
  moves,
  onSelect,
  onRetrySave,
}: {
  readonly view: EvaluationView;
  readonly selectedPly: number;
  readonly moves: GameSnapshot["moves"];
  readonly onSelect?: ((ply: number) => void) | undefined;
  readonly onRetrySave: () => void;
}) {
  const { t } = useTranslation();
  const current = view.plies.filter((ply) => ply.sample?.profileId === PROFILE_ID).length;
  return (
    <div className="grid min-w-0 gap-4">
      <p className="text-caption text-text-secondary">{t("analysis.clientComputed")}</p>
      <p className="text-label">{t("analysis.coverage", { current, total: view.plies.length })}</p>
      {view.persistence === "error" ? (
        <div className="grid gap-2">
          <p className="text-label text-warning">{t("analysis.saveError")}</p>
          <Button variant="quiet" onClick={onRetrySave} aria-disabled={view.suspended}>
            {t("analysis.retrySave")}
          </Button>
        </div>
      ) : null}
      {view.persistence === "obsolete" ? (
        <p className="text-label text-warning">{t("analysis.obsolete")}</p>
      ) : null}
      {view.persistence === "loading" ? (
        <p className="text-label text-text-secondary">{t("analysis.loading")}</p>
      ) : null}
      <EvaluationGraph
        plies={view.plies}
        selectedPly={selectedPly}
        moves={moves}
        onSelect={onSelect}
      />
      <a
        className="min-h-target py-2 text-label text-accent underline"
        href={`${import.meta.env.BASE_URL}${ENGINE_DIRECTORY}/index.html`}
        target="_blank"
        rel="noreferrer"
      >
        {t("analysis.attribution")}
      </a>
    </div>
  );
}
