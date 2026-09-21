import type { GameDetails, GameInvocations } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { acceptedAttempt, metricValue } from "./telemetry";

const commentaryMetrics = ["durationMs", "inputTokens", "outputTokens"] as const;

export function CommentaryPanel({
  details,
  records,
  selectedPly,
}: {
  readonly details: GameDetails;
  readonly records: GameInvocations | null;
  readonly selectedPly: number | null;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const moves = details.snapshot.moves;
  const selected = selectedPly === null ? null : moves.find((move) => move.ply === selectedPly);
  const colors =
    selectedPly === null
      ? (["white", "black"] as const).filter(
          (color) => details.configuration?.seats[color].type === "ai",
        )
      : selected
        ? [selected.ply % 2 ? ("white" as const) : ("black" as const)]
        : [];
  return (
    <section
      aria-label={t("telemetry.commentary")}
      tabIndex={0}
      className="grid min-h-0 min-w-0 shrink-0 gap-3 focus-visible:-outline-offset-2 lg:max-h-[50%] lg:overflow-y-auto lg:pr-2"
    >
      <h2 className="font-display text-section">{t("telemetry.commentary")}</h2>
      {colors.length === 0 ? (
        <p className="text-body text-text-secondary">{t("telemetry.initial")}</p>
      ) : null}
      {colors.map((color) => {
        const move =
          selected ?? moves.findLast((move) => (move.ply % 2 ? "white" : "black") === color);
        const attempt = move ? acceptedAttempt(records, move.ply) : undefined;
        const human = details.configuration?.seats[color].type === "human";
        return (
          <article key={color} className="grid min-w-0 gap-2 border-l-2 border-divider pl-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-label font-semibold wrap-anywhere">
                {move
                  ? t("telemetry.move", {
                      color: t(`players.${color}`),
                      number: Math.ceil(move.ply / 2),
                      san: move.san,
                    })
                  : t(`players.${color}`)}
              </h3>
              {attempt ? (
                <p className="text-caption text-text-secondary">
                  {t("telemetry.acceptedOn", { number: attempt.attemptNumber })}
                </p>
              ) : null}
            </div>
            <p className="text-body wrap-anywhere whitespace-pre-wrap text-text-secondary">
              {human
                ? t("telemetry.humanMove")
                : !move
                  ? t("telemetry.noMove")
                  : !attempt
                    ? t("telemetry.detailsUnavailable")
                    : attempt.commentary?.trim()
                      ? attempt.commentary
                      : t("telemetry.missingCommentary")}
            </p>
            {move && !human ? (
              <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-2 text-label">
                {commentaryMetrics.map((name) => {
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
              </dl>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
