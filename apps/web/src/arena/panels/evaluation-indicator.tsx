import { useTranslation } from "react-i18next";

import { PROFILE_ID } from "../../analysis/protocol";
import type { EvaluationPly } from "../../gameplay/analysis-controller";
import { Button } from "../../ui/button";
import { cx } from "../../ui/cx";

import { evaluationScore } from "./evaluation-copy";

export function EvaluationIndicator({
  state,
  onRetry,
  suspended = false,
  obsolete = false,
  accessError = false,
  density = "full",
}: {
  readonly state: EvaluationPly | undefined;
  readonly onRetry: () => void;
  readonly suspended?: boolean;
  readonly obsolete?: boolean;
  readonly accessError?: boolean;
  readonly density?: "full" | "compact";
}) {
  const { t, i18n } = useTranslation();
  const status = state?.status ?? "pending";
  const sample = state?.sample;
  const compact = density === "compact";
  const score = sample ? (
    <p
      className={cx("font-mono tabular-nums", compact ? "text-body" : "text-section")}
      data-testid="evaluation-score"
    >
      {evaluationScore(sample.score, t, i18n.language)}
    </p>
  ) : null;
  const provenance = sample ? (
    <p className="text-caption wrap-anywhere text-text-secondary">
      {t("analysis.provenance", { profile: sample.profileId, depth: sample.depth })}
    </p>
  ) : null;
  const retry =
    !obsolete &&
    (accessError || status === "unavailable" || (status === "suspended" && !suspended));
  return (
    <section
      aria-label={t("analysis.title")}
      className={cx(
        "grid min-w-0 gap-1",
        compact
          ? "border-y border-divider py-2"
          : "rounded-control border border-divider bg-surface-raised p-3",
      )}
      data-testid="evaluation-indicator"
    >
      {compact ? (
        <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-1">
          <div className="min-w-0 flex-[1_1_12rem]">
            <h2 className="text-label font-semibold">{t("analysis.title")}</h2>
            {score}
          </div>
          {sample ? (
            <details className="max-w-full min-w-0">
              <summary className="min-h-target content-center rounded-control px-2 text-label text-text-secondary">
                {t("analysis.provenanceDetails")}
              </summary>
              {provenance}
            </details>
          ) : null}
        </div>
      ) : (
        <>
          <h2 className="text-label font-semibold">{t("analysis.title")}</h2>
          {score}
          {provenance}
        </>
      )}
      {sample ? (
        <>
          {sample.profileId !== PROFILE_ID || obsolete ? (
            <p className="text-caption text-warning">{t("analysis.older")}</p>
          ) : null}
          <p className="text-caption text-text-secondary">{t(`analysis.saved.${state.saved}`)}</p>
        </>
      ) : null}
      {compact && obsolete ? (
        <p className="text-caption text-warning">{t("analysis.obsolete")}</p>
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
