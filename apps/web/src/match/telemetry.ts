import type {
  ChessColor,
  CostUnavailableReason,
  GameDetails,
  GameInvocations,
  ModelInvocation,
} from "@neurochess/contracts";

import { plyColor } from "../gameplay/snapshot";

export const metricNames = ["durationMs", "inputTokens", "outputTokens", "totalTokens"] as const;
export type MetricName = (typeof metricNames)[number];

export type TelemetryCostReason = CostUnavailableReason | "missing_history" | "no_attempts";
export interface CostSummary {
  readonly amount: string | null;
  readonly knownAmount: string | null;
  readonly reported: number;
  readonly reasons: readonly TelemetryCostReason[];
}

function costTotals(attempts: readonly ModelInvocation[], missingMoves: number): CostSummary {
  let picoUsd = 0n;
  let reported = 0;
  const reasons = new Set<TelemetryCostReason>();
  for (const { cost } of attempts) {
    if (cost.status === "unavailable") {
      reasons.add(cost.reason);
    } else {
      picoUsd += BigInt(cost.amount.replace(".", ""));
      reported++;
    }
  }
  if (missingMoves > 0) reasons.add("missing_history");
  else if (!attempts.length) reasons.add("no_attempts");
  const digits = picoUsd.toString().padStart(13, "0");
  const knownAmount = reported ? `${digits.slice(0, -12)}.${digits.slice(-12)}` : null;
  return {
    amount: reasons.size ? null : knownAmount,
    knownAmount,
    reported,
    reasons: [...reasons],
  };
}

export function moveCost(records: GameInvocations | null, ply: number): CostSummary {
  const turn = records?.turns.find((turn) => turn.acceptedMovePly === ply);
  return costTotals(turn?.attempts ?? [], turn ? 0 : 1);
}

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
  color?: ChessColor,
) {
  const attempts = records.turns.flatMap((turn) =>
    !color || turn.color === color ? turn.attempts : [],
  );
  const recordedMoves = new Set(records.turns.map((turn) => turn.acceptedMovePly));
  const missingMoves = details.snapshot.moves.filter((move) => {
    const moveColor = plyColor(move.ply);
    return (
      move.ply <= moveCount &&
      (!color || moveColor === color) &&
      details.configuration?.seats[moveColor].type === "ai" &&
      !recordedMoves.has(move.ply)
    );
  }).length;
  return {
    attempts: attempts.length,
    missingMoves,
    cost: costTotals(attempts, missingMoves),
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
