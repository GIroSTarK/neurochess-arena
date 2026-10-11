import type { CostEstimate } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { formatUsd } from "./cost-format";
import type { CostSummary } from "./telemetry";

export function CostDetails({
  cost,
  attempts,
}: {
  readonly cost: CostSummary;
  readonly attempts: number;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="col-span-full min-w-0">
      <dt className="text-text-secondary">{t("telemetry.estimatedCost")}</dt>
      <dd className="font-mono wrap-anywhere">
        {cost.amount === null ? t("telemetry.unavailable") : formatUsd(cost.amount, i18n.language)}
      </dd>
      {cost.reasons.map((reason) => (
        <dd key={reason} className="text-text-secondary">
          {t(`telemetry.costReasons.${reason}`)}
        </dd>
      ))}
      {cost.amount === null ? (
        <>
          {cost.knownAmount !== null ? (
            <dd className="wrap-anywhere">
              {t("telemetry.knownCost", { value: formatUsd(cost.knownAmount, i18n.language) })}
            </dd>
          ) : null}
          <dd className="text-text-secondary">
            {t("telemetry.costCoverage", { reported: cost.reported, count: attempts })}
          </dd>
        </>
      ) : null}
    </div>
  );
}

export function AttemptCost({ cost }: { readonly cost: CostEstimate }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="col-span-full min-w-0">
      <dt className="text-text-secondary">{t("telemetry.estimatedCost")}</dt>
      <dd className="font-mono wrap-anywhere">
        {cost.status === "estimated"
          ? formatUsd(cost.amount, i18n.language)
          : t("telemetry.unavailable")}
      </dd>
      {cost.status === "unavailable" ? (
        <dd className="text-text-secondary">{t(`telemetry.costReasons.${cost.reason}`)}</dd>
      ) : null}
    </div>
  );
}
