import type { AiGameConfiguration, GameInvocation, GameSnapshot } from "@neurochess/contracts";
import { useId } from "react";
import { useTranslation } from "react-i18next";

function Measurements({ invocation }: { readonly invocation: GameInvocation }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? "en", { maximumFractionDigits: 2 });
  return (
    <dl className="grid grid-cols-2 gap-3 text-label">
      {(
        [
          ["latency", invocation.latencyMs],
          ["inputTokens", invocation.usage.inputTokens],
          ["outputTokens", invocation.usage.outputTokens],
          ["totalTokens", invocation.usage.totalTokens],
        ] as const
      ).map(([key, value]) => (
        <div key={key} className="min-w-0 wrap-anywhere">
          <dt className="text-text-secondary">{t(`telemetry.${key}`)}</dt>
          <dd className="mt-1 font-mono tabular-nums">
            {value === null
              ? t("telemetry.unavailable")
              : key === "latency"
                ? t("telemetry.milliseconds", { value: number.format(value) })
                : number.format(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Commentary({ text }: { readonly text: string | null }) {
  const { t } = useTranslation();
  return (
    <p className="wrap-anywhere whitespace-pre-wrap text-text-secondary">
      {text?.trim() ? text : t("telemetry.noCommentary")}
    </p>
  );
}

export function InvocationDetails({
  snapshot,
  match,
  selectedPly,
}: {
  readonly snapshot: GameSnapshot;
  readonly match: AiGameConfiguration;
  readonly selectedPly?: number | undefined;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const eventsId = useId();
  const invocations = snapshot.invocations ?? [];
  const accepted = invocations.filter((invocation) => invocation.accepted);
  const displayed =
    selectedPly === undefined
      ? (["white", "black"] as const).flatMap((color) => {
          const latest = accepted.findLast((invocation) => invocation.color === color);
          return latest ? [latest] : [];
        })
      : accepted.filter((invocation) => invocation.ply === selectedPly);
  const humanMove =
    selectedPly !== undefined &&
    selectedPly > 0 &&
    match.mode === "ai_vs_human" &&
    (selectedPly % 2 === 1 ? "white" : "black") === match.humanColor;

  function label(invocation: GameInvocation) {
    return t("telemetry.attempt", {
      ply: invocation.ply,
      color: t(`players.${invocation.color}`),
      attempt: invocation.attempt,
    });
  }

  return (
    <>
      <section className="min-w-0 space-y-4" aria-labelledby={headingId}>
        <h2 id={headingId} className="text-section font-semibold">
          {t(selectedPly === undefined ? "telemetry.latest" : "telemetry.selected")}
        </h2>
        {displayed.length === 0 ? (
          <p className="text-text-secondary">
            {t(
              selectedPly === 0
                ? "telemetry.initial"
                : humanMove
                  ? "telemetry.humanMove"
                  : "telemetry.noMoves",
            )}
          </p>
        ) : (
          displayed.map((invocation) => {
            const move = snapshot.moves[invocation.ply - 1];
            if (!move) return null;
            const configuration = match.mode === "ai_vs_ai" ? match[invocation.color] : match.ai;
            return (
              <article
                key={invocation.ply}
                className="space-y-3 rounded-panel border border-divider bg-surface p-4"
                aria-label={t("telemetry.move", { ply: invocation.ply })}
              >
                <h3 className="font-semibold wrap-anywhere">
                  {t("telemetry.moveLabel", {
                    ply: invocation.ply,
                    color: t(`players.${invocation.color}`),
                    move: move.san,
                  })}
                </h3>
                <p className="text-label wrap-anywhere text-text-muted">
                  {configuration.provider} · {configuration.modelId}
                </p>
                <Commentary text={invocation.commentary} />
                <Measurements invocation={invocation} />
              </article>
            );
          })
        )}
        <p className="text-caption text-text-muted">{t("telemetry.measurementHint")}</p>
      </section>
      <section className="min-w-0" aria-labelledby={eventsId}>
        <h2 id={eventsId} className="text-section font-semibold">
          {t("telemetry.events")}
        </h2>
        <p className="mt-2 text-caption text-text-muted">{t("telemetry.attemptHint")}</p>
        {invocations.length === 0 ? (
          <p className="mt-3 text-text-secondary">{t("telemetry.noAttempts")}</p>
        ) : (
          <ol className="mt-3 max-h-112 [scrollbar-gutter:stable] space-y-2 overflow-auto overscroll-contain">
            {invocations.map((invocation) => (
              <li key={`${invocation.ply}:${invocation.attempt}`}>
                <details className="rounded-control border border-divider bg-surface">
                  <summary className="min-h-target cursor-pointer p-3 wrap-anywhere">
                    <span className="text-label font-semibold">{label(invocation)}</span>
                    <span className="mt-1 block text-label text-text-secondary">
                      {invocation.error
                        ? t(
                            `telemetry.errors.${invocation.error.kind === "model_invalid" ? invocation.error.reason : invocation.error.kind}`,
                          )
                        : t(
                            `telemetry.status.${invocation.accepted ? "accepted" : invocation.status}`,
                          )}
                    </span>
                  </summary>
                  <div className="space-y-3 border-t border-divider p-3">
                    {invocation.accepted ? <Commentary text={invocation.commentary} /> : null}
                    <Measurements invocation={invocation} />
                  </div>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
