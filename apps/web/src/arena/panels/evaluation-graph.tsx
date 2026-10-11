import type { GameSnapshot } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { PROFILE_ID } from "../../analysis/protocol";
import type { EvaluationPly } from "../../gameplay/analysis-controller";
import { Button } from "../../ui/button";

import { evaluationScore } from "./evaluation-copy";

export function EvaluationGraph({
  plies,
  selectedPly,
  moves,
  onSelect,
}: {
  readonly plies: readonly EvaluationPly[];
  readonly selectedPly: number;
  readonly moves: GameSnapshot["moves"];
  readonly onSelect?: ((ply: number) => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  let extent = 100;
  for (const ply of plies) {
    if (ply.sample?.score.kind === "cp") {
      extent = Math.max(extent, Math.abs(ply.sample.score.value));
    }
  }
  const x = (ply: number) => 40 + (ply / Math.max(1, plies.length - 1)) * 440;
  const y = (score: number) => 105 - (score / extent) * 65;
  const segments: string[][] = [];
  let segment: string[] = [];
  plies.forEach((ply, index) => {
    if (ply.sample?.score.kind === "cp") segment.push(`${x(index)},${y(ply.sample.score.value)}`);
    else {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    }
  });
  if (segment.length > 1) segments.push(segment);
  const label = (ply: number) =>
    ply === 0 ? t("analysis.initial") : t("analysis.ply", { ply, move: moves[ply - 1]?.san ?? "" });
  return (
    <section className="grid min-w-0 gap-3" aria-label={t("analysis.graph")}>
      <h2 className="font-display text-section">{t("analysis.graph")}</h2>
      <p className="text-caption text-text-secondary">{t("analysis.scale")}</p>
      <svg
        viewBox="0 0 500 200"
        role="img"
        aria-label={t("analysis.graphDescription")}
        className="w-full overflow-visible text-accent"
      >
        <line x1="40" x2="480" y1="105" y2="105" className="stroke-control-border" />
        <text x="2" y="44" className="fill-text-secondary text-[12px]">
          +{extent / 100}
        </text>
        <text x="12" y="109" className="fill-text-secondary text-[12px]">
          0
        </text>
        <text x="2" y="174" className="fill-text-secondary text-[12px]">
          −{extent / 100}
        </text>
        {segments.map((points, index) => (
          <polyline
            key={index}
            points={points.join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        ))}
        {plies.map((ply, index) =>
          ply.sample ? (
            ply.sample.score.kind === "cp" ? (
              <circle
                key={index}
                cx={x(index)}
                cy={y(ply.sample.score.value)}
                r="3"
                fill="currentColor"
              />
            ) : (
              <text
                key={index}
                x={x(index)}
                y="20"
                textAnchor="middle"
                className="fill-warning text-[12px]"
              >
                M
              </text>
            )
          ) : null,
        )}
        <line
          x1={x(selectedPly)}
          x2={x(selectedPly)}
          y1="28"
          y2="178"
          className="stroke-text"
          strokeDasharray="4 4"
          data-testid="evaluation-marker"
          data-ply={selectedPly}
        />
        <text x="40" y="197" className="fill-text-secondary text-[12px]">
          0
        </text>
        <text x="480" y="197" textAnchor="end" className="fill-text-secondary text-[12px]">
          {plies.length - 1}
        </text>
      </svg>
      {onSelect && plies.length > 1 ? (
        <label className="grid gap-2 text-label">
          {t("analysis.position")}
          <input
            type="range"
            min={0}
            max={plies.length - 1}
            value={selectedPly}
            onChange={(event) => onSelect(Number(event.target.value))}
            className="min-h-target w-full accent-accent"
          />
        </label>
      ) : null}
      <p className="text-label" data-testid="evaluation-selected">
        {label(selectedPly)} ·{" "}
        {plies[selectedPly]?.sample
          ? evaluationScore(plies[selectedPly].sample.score, t, i18n.language)
          : t("analysis.unknown")}
      </p>
      <details>
        <summary className="min-h-target cursor-pointer py-3 text-label text-accent">
          {t("analysis.values")}
        </summary>
        <table className="w-full table-fixed text-left text-caption wrap-anywhere">
          <caption className="sr-only">{t("analysis.values")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("analysis.position")}</th>
              <th scope="col">{t("analysis.value")}</th>
              <th scope="col">{t("analysis.details")}</th>
            </tr>
          </thead>
          <tbody>
            {plies.map((ply, index) => (
              <tr
                key={index}
                aria-current={index === selectedPly ? "true" : undefined}
                className="border-t border-divider align-top aria-current:bg-surface-raised"
              >
                <th scope="row" className="py-2 wrap-anywhere">
                  {onSelect ? (
                    <Button
                      variant="quiet"
                      onClick={() => onSelect(index)}
                      aria-current={index === selectedPly ? "step" : undefined}
                    >
                      {label(index)}
                    </Button>
                  ) : (
                    label(index)
                  )}
                </th>
                <td className="px-1 py-2 wrap-anywhere">
                  {ply.sample
                    ? evaluationScore(ply.sample.score, t, i18n.language)
                    : t(`analysis.states.${ply.status}`)}
                </td>
                <td className="py-2 wrap-anywhere">
                  {ply.sample ? (
                    <>
                      {t("analysis.provenance", {
                        profile: ply.sample.profileId,
                        depth: ply.sample.depth,
                      })}
                      <br />
                      {ply.sample.profileId !== PROFILE_ID ? t("analysis.older") : null}
                      <br />
                      {t(`analysis.saved.${ply.saved}`)}
                    </>
                  ) : (
                    t("analysis.unknown")
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
