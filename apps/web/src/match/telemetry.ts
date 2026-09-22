import type { GameDetails, GameInvocations, ModelInvocation } from "@neurochess/contracts";

export const metricNames = ["durationMs", "inputTokens", "outputTokens", "totalTokens"] as const;
export type MetricName = (typeof metricNames)[number];

export function metricValue(attempt: ModelInvocation | undefined, metric: MetricName) {
  return metric === "durationMs"
    ? (attempt?.durationMs ?? null)
    : (attempt?.usage?.[metric] ?? null);
}

export function acceptedAttempt(records: GameInvocations | null, ply: number) {
  return records?.turns
    .find((turn) => turn.acceptedMovePly === ply)
    ?.attempts.find((attempt) => attempt.outcome === "accepted");
}

export function operationalTotals(
  details: GameDetails,
  records: GameInvocations,
  moveCount = details.snapshot.moves.length,
) {
  const attempts = records.turns.flatMap((turn) => turn.attempts);
  const recordedMoves = new Set(records.turns.map((turn) => turn.acceptedMovePly));
  const missingMoves = details.snapshot.moves.filter((move) => {
    const color = move.ply % 2 ? "white" : "black";
    return (
      move.ply <= moveCount &&
      details.configuration?.seats[color].type === "ai" &&
      !recordedMoves.has(move.ply)
    );
  }).length;
  return {
    attempts: attempts.length,
    missingMoves,
    metrics: metricNames.map((name) => {
      const values = attempts.map((attempt) => metricValue(attempt, name));
      const reported = values.filter((value) => value !== null);
      const sum = reported.reduce((total, value) => total + value, 0);
      return {
        name,
        reported: reported.length,
        value:
          !missingMoves &&
          values.length > 0 &&
          reported.length === values.length &&
          Number.isSafeInteger(sum)
            ? sum
            : null,
      };
    }),
  };
}
