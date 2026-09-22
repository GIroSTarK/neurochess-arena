import { gameInvocationsSchema } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { invocationRecords, telemetryDetails } from "../test/ai-invocations";
import { snapshot } from "../test/fixtures";

import { acceptedAttempt, metricValue, operationalTotals } from "./telemetry";

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
    expect(totals).toEqual({
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
