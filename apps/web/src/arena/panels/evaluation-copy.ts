import type { TFunction } from "i18next";

import type { AnalysisScore } from "../../analysis/protocol";

export function evaluationScore(score: AnalysisScore, t: TFunction, language: string): string {
  if (score.kind === "mate") {
    return t(score.moves === 0 ? "analysis.checkmate" : "analysis.mate", {
      color: t(`players.${score.winner}`),
      count: score.moves,
    });
  }
  const value = new Intl.NumberFormat(language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(score.value / 100);
  return t(score.value === 0 ? "analysis.equal" : "analysis.advantage", {
    value,
    color: t(`players.${score.value > 0 ? "white" : "black"}`),
  });
}
