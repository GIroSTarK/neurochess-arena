import { costUnavailableReasonSchema } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { formatUsd } from "./cost-format";
import type { CostSummary } from "./telemetry";

export function MoveCost({
  cost,
  pending,
}: {
  readonly cost: CostSummary | null;
  readonly pending: boolean;
}) {
  const { t, i18n } = useTranslation();
  const reason = cost?.reasons[0];
  const variants = [
    t("telemetry.pending"),
    formatUsd("0.000000000001", i18n.language),
    ...([...costUnavailableReasonSchema.options, "missing_history", "no_attempts"] as const).map(
      (reason) => t(`telemetry.costReasons.${reason}`),
    ),
    t("telemetry.costIncomplete"),
  ];
  const value =
    pending || !cost
      ? t("telemetry.pending")
      : cost.amount !== null
        ? formatUsd(cost.amount, i18n.language)
        : cost.reasons.length === 1 && reason
          ? t(`telemetry.costReasons.${reason}`)
          : t("telemetry.costIncomplete");
  return (
    <div className="col-span-full grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
      <dt className="text-text-secondary">{t("telemetry.moveEstimate")}</dt>
      <dd className="grid min-w-0 wrap-anywhere">
        {variants.map((variant) => (
          <span
            key={variant}
            aria-hidden="true"
            data-placeholder={variant}
            className="invisible min-w-0 [grid-area:1/1] before:content-[attr(data-placeholder)]"
          />
        ))}
        <span className="min-w-0 self-start [grid-area:1/1]">{value}</span>
      </dd>
    </div>
  );
}
