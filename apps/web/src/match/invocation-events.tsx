import type { GameInvocations, GameSnapshot, ProviderFailure } from "@neurochess/contracts";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { resultReason } from "../arena/result";

import { AttemptCost } from "./cost-details";
import { metricNames, metricValue } from "./telemetry";
import { TelemetryStatus } from "./telemetry-status";

function failureReason(error: ProviderFailure, t: TFunction) {
  return "reason" in error
    ? t(`telemetry.reasons.${error.reason}`)
    : t(`telemetry.reasons.${error.code}`);
}

export function InvocationEvents({
  records,
  snapshot,
  loading = false,
  error = false,
}: {
  readonly records: GameInvocations | null;
  readonly snapshot: GameSnapshot;
  readonly loading?: boolean;
  readonly error?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <section aria-label={t("telemetry.events")} className="grid min-w-0 gap-4 text-body">
      {snapshot.terminationReason ? <p>{resultReason(snapshot, t)}</p> : null}
      <p className="text-label text-text-secondary">{t("telemetry.retryPolicy")}</p>
      <p className="text-label text-text-secondary">{t("telemetry.estimateBasis")}</p>
      <TelemetryStatus
        hasRecords={Boolean(records)}
        loading={loading}
        error={error}
        stale={Boolean(records && records.version !== snapshot.version)}
      />
      {!records ? (
        <p>{t("telemetry.detailsUnavailable")}</p>
      ) : records.turns.length === 0 ? (
        <p>{t("telemetry.noAttempts")}</p>
      ) : (
        <ol aria-label={t("telemetry.events")} className="grid min-w-0 gap-5">
          {records.turns.map((turn) => (
            <li key={turn.id} className="grid min-w-0 gap-2">
              <h3 className="text-label font-semibold">
                {t("telemetry.turn", {
                  color: t(`players.${turn.color}`),
                  number: Math.ceil(turn.ply / 2),
                })}
              </h3>
              <p className="text-label text-text-secondary">
                {t("telemetry.invalidCount", { count: turn.invalidOutputCount })}
              </p>
              {turn.acceptedMovePly === null ? (
                <p className="text-label text-text-secondary">{t("telemetry.turnWithoutMove")}</p>
              ) : null}
              <ol className="grid gap-3 border-l border-divider pl-3">
                {turn.attempts.map((attempt) => (
                  <li key={attempt.id} className="min-w-0 text-label wrap-anywhere">
                    <p className="font-semibold">
                      {t("telemetry.attempt", {
                        number: attempt.attemptNumber,
                        outcome: t(`telemetry.outcomes.${attempt.outcome}`),
                      })}
                    </p>
                    <p className="text-text-secondary">
                      {t(`setup.providers.${attempt.provider}`)} · {attempt.modelId}
                    </p>
                    {attempt.error ? <p>{failureReason(attempt.error, t)}</p> : null}
                    {attempt.outcome === "provider_error" ? (
                      <p>{t("telemetry.manualRetry")}</p>
                    ) : null}
                    <dl className="mt-2 grid grid-cols-2 gap-2">
                      {metricNames.map((name) => {
                        const value = metricValue(attempt, name);
                        return (
                          <div key={name} className="min-w-0">
                            <dt className="text-text-secondary">{t(`telemetry.${name}`)}</dt>
                            <dd className="font-mono wrap-anywhere">
                              {value === null
                                ? t("telemetry.unavailable")
                                : name === "durationMs"
                                  ? t("telemetry.milliseconds", { value: number.format(value) })
                                  : number.format(value)}
                            </dd>
                          </div>
                        );
                      })}
                      <AttemptCost cost={attempt.cost} />
                    </dl>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
