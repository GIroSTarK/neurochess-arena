import type { MoveRecord } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { plyColor } from "../gameplay/snapshot";

import { referenceMoveData, type ReferenceScenario } from "./scenarios";

export function ReferencePanels({
  scenario,
  moves,
  selectedPly,
  kind,
}: {
  readonly scenario: ReferenceScenario;
  readonly moves: readonly MoveRecord[];
  readonly selectedPly?: number | undefined;
  readonly kind: "commentary" | "telemetry";
}) {
  const { t, i18n } = useTranslation();
  const selected =
    selectedPly === undefined ? undefined : moves.find((move) => move.ply === selectedPly);
  const colors =
    selectedPly === undefined
      ? (["white", "black"] as const)
      : selected
        ? [plyColor(selected.ply)]
        : [];
  const numbers = new Intl.NumberFormat(i18n.resolvedLanguage);
  const dollars = new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
  });

  return (
    <section className="min-w-0 shrink-0" aria-label={t(`reference.${kind}`)}>
      <h2 className="border-b border-divider pb-2 text-section font-semibold">
        {t(`reference.${kind}`)}
      </h2>
      {selectedPly === 0 ? (
        <p className="mt-2 text-body">
          {t(kind === "commentary" ? "telemetry.initial" : "reference.unavailable")}
        </p>
      ) : null}
      {colors.map((color) => {
        const identity = scenario.players[color];
        if (identity.kind !== "ai") {
          return kind === "commentary" && selected ? (
            <p key={color} className="mt-2 text-body">
              {t("telemetry.humanMove")}
            </p>
          ) : null;
        }
        const move = selected ?? moves.findLast((move) => plyColor(move.ply) === color);
        const data = move ? referenceMoveData[move.ply - 1] : undefined;
        const metrics = [
          {
            label: t("reference.latency"),
            value: data
              ? t("reference.seconds", { value: numbers.format(data.latencyMs / 1000) })
              : null,
          },
          {
            label: t("reference.tokens"),
            value: data?.tokens == null ? null : numbers.format(data.tokens),
          },
          {
            label: t("reference.cost"),
            value: data?.costUsd == null ? null : dollars.format(data.costUsd),
          },
        ];
        return (
          <div
            key={color}
            role="group"
            aria-label={t(
              kind === "commentary" ? "reference.commentarySeat" : "reference.telemetrySeat",
              {
                color: t(`players.${color}`),
              },
            )}
            className="min-w-0 border-b border-divider py-3 wrap-anywhere last:border-0 last:pb-0"
          >
            <h3 className="text-label font-medium text-text-secondary">
              {t("reference.commentaryMove", {
                color: t(`players.${color}`),
                model: identity.model,
                move: move
                  ? `${Math.ceil(move.ply / 2)}${color === "white" ? "." : "..."} ${move.san}`
                  : "—",
              })}
            </h3>
            {kind === "commentary" ? (
              <p className="mt-2 text-body">
                {data?.commentary ? t(`reference.${data.commentary}`) : t("reference.noCommentary")}
              </p>
            ) : (
              <>
                <dl className="mt-2 grid grid-cols-3 gap-3 text-label">
                  {metrics.map((metric) => (
                    <div key={metric.label} className="min-w-0">
                      <dt className="text-text-muted">{metric.label}</dt>
                      <dd className="mt-1 font-mono">
                        {metric.value ?? t("reference.unavailable")}
                      </dd>
                    </div>
                  ))}
                </dl>
                {move && data?.tokens == null ? (
                  <p className="mt-2 text-caption text-text-muted">{t("reference.missingUsage")}</p>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
