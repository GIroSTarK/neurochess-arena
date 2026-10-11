import { gameInvocationsSchema } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import {
  estimatedCost,
  invocationRecords,
  pricedInvocationRecords,
  telemetryDetails,
} from "../test/ai-invocations";
import { snapshot } from "../test/fixtures";

import { acceptedAttempt, metricValue, moveCost, operationalTotals } from "./telemetry";

describe("invocation telemetry", () => {
  it("selects only the accepted attempt for a replay ply, retaining reported zero", () => {
    const records = invocationRecords();
    const accepted = acceptedAttempt(records, 1);
    expect(accepted?.attemptNumber).toBe(3);
    expect(metricValue(accepted, "durationMs")).toBe(300);
    expect(metricValue(accepted, "totalTokens")).toBe(0);
    expect(acceptedAttempt(records, 0)).toBeUndefined();
    expect(acceptedAttempt(records, 3)).toBeUndefined();
  });
  it("includes retries and failures, without synthesizing totals or summing incomplete usage", () => {
    const totals = operationalTotals(telemetryDetails, invocationRecords());
    expect(totals).toMatchObject({
      attempts: 4,
      missingMoves: 0,
      metrics: [
        { name: "durationMs", reported: 4, value: 1000 },
        { name: "inputTokens", reported: 3, value: null },
        { name: "outputTokens", reported: 3, value: null },
        { name: "totalTokens", reported: 2, value: null },
      ],
    });
  });

  it("sums exact stored estimates across a move's retries and separates identical models by seat", () => {
    const records = pricedInvocationRecords();
    const black = records.turns[1]!.attempts[0]!;
    Object.assign(black, { provider: "openai", modelId: "fixture-white" });
    black.cost = estimatedCost("0.000000000004", black);
    const details = {
      ...telemetryDetails,
      configuration: {
        ...telemetryDetails.configuration,
        seats: {
          white: telemetryDetails.configuration.seats.white,
          black: telemetryDetails.configuration.seats.white,
        },
      },
    };
    gameInvocationsSchema.parse(records);
    expect(moveCost(records, 1)).toMatchObject({
      amount: "0.300000000003",
      reported: 3,
      reasons: [],
    });
    expect(operationalTotals(details, records).cost.amount).toBe("0.300000000007");
    expect(operationalTotals(details, records, 2, "white").cost.amount).toBe("0.300000000003");
    expect(operationalTotals(details, records, 2, "black").cost.amount).toBe("0.000000000004");
    expect(metricValue(acceptedAttempt(records, 1), "durationMs")).toBe(300);
  });

  it("keeps known estimates inspectable while missing usage, prices or historical invocations invalidate only affected totals", () => {
    const records = pricedInvocationRecords();
    records.turns[0]!.attempts[0]!.cost = { status: "unavailable", reason: "usage_incomplete" };
    records.turns[0]!.attempts[1]!.cost = { status: "unavailable", reason: "model_price_unknown" };
    expect(moveCost(records, 1)).toEqual({
      amount: null,
      knownAmount: "0.000000000000",
      reported: 1,
      reasons: ["usage_incomplete", "model_price_unknown"],
    });
    expect(operationalTotals(telemetryDetails, records).cost).toMatchObject({
      amount: null,
      knownAmount: "0.000000000004",
      reported: 2,
    });
    expect(operationalTotals(telemetryDetails, records, 2, "black").cost.amount).toBe(
      "0.000000000004",
    );
    records.turns.shift();
    expect(moveCost(records, 1)).toMatchObject({
      amount: null,
      knownAmount: null,
      reasons: ["missing_history"],
    });
    expect(operationalTotals(telemetryDetails, records).cost).toMatchObject({
      amount: null,
      knownAmount: "0.000000000004",
      reasons: ["missing_history"],
    });
    expect(operationalTotals(telemetryDetails, records, 2, "black").cost.amount).toBe(
      "0.000000000004",
    );
  });

  it("includes known failed and discarded attempts without accepted moves, including after technical loss", () => {
    const records = pricedInvocationRecords();
    const failed = records.turns[0]!.attempts[0]!;
    records.turns.push({
      id: crypto.randomUUID(),
      ply: 3,
      color: "white",
      acceptedMovePly: null,
      invalidOutputCount: 3,
      attempts: [1, 2, 3, 4].map((attemptNumber) => ({
        ...failed,
        id: crypto.randomUUID(),
        attemptNumber,
        outcome: attemptNumber === 1 ? ("discarded" as const) : ("model_invalid" as const),
        cost: estimatedCost("0.000000000001", failed),
      })),
    });
    gameInvocationsSchema.parse(records);
    expect(operationalTotals(telemetryDetails, records)).toMatchObject({
      attempts: 8,
      cost: { amount: "0.300000000011" },
    });
    expect(moveCost(records, 1).amount).toBe("0.300000000003");
    expect(moveCost(records, 3).amount).toBeNull();
  });

  it("preserves zero and large precise totals but never turns unknown or empty cost into zero", () => {
    const records = pricedInvocationRecords();
    const attempts = records.turns.flatMap((turn) => turn.attempts);
    attempts.forEach((attempt) => {
      attempt.cost = estimatedCost("0.000000000000", attempt);
    });
    expect(operationalTotals(telemetryDetails, records).cost.amount).toBe("0.000000000000");
    attempts[0]!.cost = estimatedCost("9007199254740993.123456789012", attempts[0]!);
    attempts[1]!.cost = estimatedCost("0.000000000001", attempts[1]!);
    expect(operationalTotals(telemetryDetails, records).cost.amount).toBe(
      "9007199254740993.123456789013",
    );
    attempts[0]!.cost = { status: "unavailable", reason: "dispatch_unknown" };
    expect(operationalTotals(telemetryDetails, records).cost).toMatchObject({
      amount: null,
      reasons: ["dispatch_unknown"],
    });
    expect(
      operationalTotals({ ...telemetryDetails, snapshot: snapshot() }, { ...records, turns: [] })
        .cost,
    ).toEqual({ amount: null, knownAmount: null, reported: 0, reasons: ["no_attempts"] });
  });
  it("keeps independent counts, unresolved work and pre-record history unknown", () => {
    const records = invocationRecords();
    records.turns[0]!.attempts = [{ ...records.turns[0]!.attempts[2]!, attemptNumber: 1 }];
    records.turns[0]!.invalidOutputCount = 0;
    const metrics = operationalTotals(telemetryDetails, records).metrics;
    expect(metrics).toContainEqual({ name: "totalTokens", reported: 2, value: 20 });
    records.turns[1]!.attempts[0]!.usage!.outputTokens = null;
    expect(operationalTotals(telemetryDetails, records).metrics).toContainEqual({
      name: "outputTokens",
      reported: 1,
      value: null,
    });
    records.turns.push({
      id: crypto.randomUUID(),
      ply: 3,
      color: "white",
      acceptedMovePly: null,
      invalidOutputCount: 0,
      attempts: [
        {
          ...records.turns[0]!.attempts[0]!,
          id: crypto.randomUUID(),
          outcome: "interrupted",
          durationMs: null,
          usage: null,
          commentary: null,
        },
      ],
    });
    gameInvocationsSchema.parse(records);
    expect(operationalTotals(telemetryDetails, records).metrics[0]?.value).toBeNull();
    records.turns.pop();
    records.turns.pop();
    const incomplete = operationalTotals(telemetryDetails, records);
    expect(incomplete.missingMoves).toBe(1);
    expect(incomplete.metrics.every((metric) => metric.value === null)).toBe(true);
  });
  it("does not call empty telemetry zero or count human moves as missing invocations", () => {
    const records = { ...invocationRecords(), turns: [] };
    expect(
      operationalTotals(telemetryDetails, records).metrics.every((metric) => metric.value === null),
    ).toBe(true);
    const humanDetails = {
      ...telemetryDetails,
      configuration: {
        mode: "ai_vs_human" as const,
        seats: {
          white: { type: "human" as const },
          black: telemetryDetails.configuration.seats.black,
        },
      },
    };
    expect(operationalTotals(humanDetails, records).missingMoves).toBe(1);
  });

  it("keeps totals for the received history while the next move's records are pending", () => {
    const records = invocationRecords();
    const next = { ...telemetryDetails, snapshot: snapshot(["e2e4", "e7e5", "g1f3"]) };
    expect(operationalTotals(next, records, 2)).toEqual(
      operationalTotals(telemetryDetails, records),
    );
    expect(operationalTotals(next, records).missingMoves).toBe(1);
  });
});
