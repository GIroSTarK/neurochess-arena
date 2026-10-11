import type { GameDetails, GameInvocations } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/button";

import { CostDetails } from "./cost-details";
import { operationalTotals } from "./telemetry";
import { TelemetryStatus } from "./telemetry-status";

function Totals({ totals }: { readonly totals: ReturnType<typeof operationalTotals> }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <>
      <p className="text-label">{t("telemetry.attemptCount", { count: totals.attempts })}</p>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3 text-label wrap-anywhere">
        {totals.metrics.map(({ name, value, reported }) => (
          <div key={name} className="min-w-0">
            <dt className="text-text-secondary">
              {t(name === "durationMs" ? "telemetry.totalDuration" : `telemetry.${name}`)}
            </dt>
            <dd className="font-mono wrap-anywhere">
              {value === null
                ? t("telemetry.unavailable")
                : name === "durationMs"
                  ? t("telemetry.milliseconds", { value: number.format(value) })
                  : number.format(value)}
            </dd>
            {value === null ? (
              <dd className="text-text-secondary">
                {t("telemetry.coverage", { reported, count: totals.attempts })}
              </dd>
            ) : null}
          </div>
        ))}
        <CostDetails cost={totals.cost} attempts={totals.attempts} />
      </dl>
      {totals.missingMoves > 0 ? (
        <p className="text-label text-text-secondary">{t("telemetry.missingHistory")}</p>
      ) : null}
    </>
  );
}

export function TelemetryPanel({
  details,
  records,
  loading,
  error,
  onRefresh,
  recordedMoveCount = details.snapshot.moves.length,
}: {
  readonly details: GameDetails;
  readonly records: GameInvocations | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly onRefresh: () => void;
  readonly recordedMoveCount?: number;
}) {
  const { t } = useTranslation();
  const totals = records ? operationalTotals(details, records, recordedMoveCount) : null;
  return (
    <section aria-label={t("telemetry.totals")} className="grid min-w-0 gap-3">
      <h2 className="font-display text-section">{t("telemetry.totals")}</h2>
      <p className="text-label text-text-secondary">{t("telemetry.includesAttempts")}</p>
      <p className="text-label text-text-secondary">{t("telemetry.estimateBasis")}</p>
      <TelemetryStatus
        hasRecords={Boolean(records)}
        loading={loading}
        error={error}
        stale={Boolean(records && records.version !== details.snapshot.version)}
      />
      {records && totals ? (
        <>
          <section aria-label={t("telemetry.gameTotals")} className="grid min-w-0 gap-3">
            <h3 className="text-body font-semibold">{t("telemetry.gameTotals")}</h3>
            <Totals totals={totals} />
          </section>
          {(["white", "black"] as const).map((color) => {
            const seat = details.configuration?.seats[color];
            const label = t("telemetry.seatTotals", { color: t(`players.${color}`) });
            return (
              <section
                key={color}
                aria-label={label}
                className="grid min-w-0 gap-3 border-t border-divider pt-3"
              >
                <h3 className="text-body font-semibold">{label}</h3>
                {seat?.type === "human" ? (
                  <p className="text-label text-text-secondary">{t("telemetry.humanCost")}</p>
                ) : (
                  <>
                    {seat?.type === "ai" ? (
                      <p className="text-label wrap-anywhere text-text-secondary">
                        {t(`setup.providers.${seat.provider}`)} · {seat.modelId}
                      </p>
                    ) : null}
                    <Totals
                      totals={operationalTotals(details, records, recordedMoveCount, color)}
                    />
                  </>
                )}
              </section>
            );
          })}
        </>
      ) : null}
      <Button variant="quiet" aria-disabled={loading} onClick={onRefresh}>
        {t("telemetry.refresh")}
      </Button>
    </section>
  );
}
