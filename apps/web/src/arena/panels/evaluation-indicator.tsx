import { useTranslation } from "react-i18next";

import { PROFILE_ID } from "../../analysis/protocol";
import type { EvaluationPly } from "../../gameplay/analysis-controller";
import { Button } from "../../ui/button";

import { evaluationScore } from "./evaluation-copy";

export function EvaluationIndicator({
  state,
  onRetry,
  suspended = false,
  obsolete = false,
  accessError = false,
}: {
  readonly state: EvaluationPly | undefined;
  readonly onRetry: () => void;
  readonly suspended?: boolean;
  readonly obsolete?: boolean;
  readonly accessError?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const status = state?.status ?? "pending";
  const sample = state?.sample;
  const retry =
    !obsolete &&
    (accessError || status === "unavailable" || (status === "suspended" && !suspended));
  return (
    <section
      aria-label={t("analysis.title")}
      className="grid min-w-0 gap-1 rounded-control border border-divider bg-surface-raised p-3"
      data-testid="evaluation-indicator"
    >
      <h2 className="text-label font-semibold">{t("analysis.title")}</h2>
      {sample ? (
        <>
          <p className="font-mono text-section tabular-nums" data-testid="evaluation-score">
            {evaluationScore(sample.score, t, i18n.language)}
          </p>
          <p className="text-caption wrap-anywhere text-text-secondary">
            {t("analysis.provenance", { profile: sample.profileId, depth: sample.depth })}
          </p>
          {sample.profileId !== PROFILE_ID || obsolete ? (
            <p className="text-caption text-warning">{t("analysis.older")}</p>
          ) : null}
          <p className="text-caption text-text-secondary">{t(`analysis.saved.${state.saved}`)}</p>
        </>
      ) : null}
      {status !== "ready" || accessError ? (
        <p className="text-label text-text-secondary">
          {t(
            accessError
              ? "analysis.accessError"
              : status === "unavailable"
                ? `analysis.reasons.${state?.reason ?? "no_score"}`
                : `analysis.states.${status}`,
          )}
        </p>
      ) : null}
      {retry ? (
        <Button variant="quiet" onClick={onRetry}>
          {t("analysis.retry")}
        </Button>
      ) : null}
    </section>
  );
}
