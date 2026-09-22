import type { GameDetails, GameInvocations } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";

import { operationalTotals } from "./telemetry";
import { TelemetryStatus } from "./TelemetryStatus";

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
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const totals = records ? operationalTotals(details, records, recordedMoveCount) : null;
  return (
    <section aria-label={t("telemetry.totals")} className="grid min-w-0 gap-3">
      <h2 className="font-display text-section">{t("telemetry.totals")}</h2>
      <p className="text-label text-text-secondary">{t("telemetry.includesAttempts")}</p>
      <TelemetryStatus
        hasRecords={Boolean(records)}
        loading={loading}
        error={error}
        stale={Boolean(records && records.version !== details.snapshot.version)}
      />
      {totals ? (
        <>
          <p className="text-label">{t("telemetry.attemptCount", { count: totals.attempts })}</p>
          <dl className="grid grid-cols-2 gap-3 text-label">
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
          </dl>
          {totals.missingMoves > 0 ? (
            <p className="text-label text-text-secondary">{t("telemetry.missingHistory")}</p>
          ) : null}
        </>
      ) : null}
      <Button variant="quiet" aria-disabled={loading} onClick={onRefresh}>
        {t("telemetry.refresh")}
      </Button>
    </section>
  );
}
