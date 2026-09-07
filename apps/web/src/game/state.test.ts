import type { GameSnapshot } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { FOOLS_MATE, OTHER_GAME_ID, snapshot } from "../test/fixtures";

import { sameSnapshot } from "./state";

/** The same fields in the opposite order, as a differently built object would present them. */
function reversedKeys(value: GameSnapshot): GameSnapshot {
  return Object.fromEntries(Object.entries(value).reverse()) as GameSnapshot;
}

describe("snapshot equality", () => {
  it("allows unfinished attempt progress but requires identical terminal telemetry", () => {
    const active = snapshot(["e2e4"]);
    const withTelemetry = snapshot(["e2e4"], {
      invocations: [
        {
          ply: 1,
          color: "white",
          attempt: 1,
          status: "succeeded",
          accepted: true,
          commentary: "For this move",
          error: null,
          latencyMs: 10,
          usage: { inputTokens: 0, outputTokens: null, totalTokens: null },
        },
      ],
    });
    expect(sameSnapshot(active, withTelemetry)).toBe(true);
    const terminal = snapshot(FOOLS_MATE, { invocations: withTelemetry.invocations });
    expect(sameSnapshot(snapshot(FOOLS_MATE), terminal)).toBe(false);
    expect(sameSnapshot(terminal, structuredClone(terminal))).toBe(true);
    expect(
      sameSnapshot(terminal, {
        ...terminal,
        invocations: terminal.invocations?.map((entry) => ({ ...entry, latencyMs: 11 })),
      }),
    ).toBe(false);
  });

  it("matches separately built snapshots of one accepted state whatever their key order", () => {
    const accepted = snapshot(FOOLS_MATE);
    const reordered = reversedKeys(snapshot(FOOLS_MATE));
    expect(Object.keys(reordered)).not.toEqual(Object.keys(accepted));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(accepted));
    expect(sameSnapshot(accepted, reordered)).toBe(true);
    expect(sameSnapshot(accepted, snapshot(FOOLS_MATE))).toBe(true);
    expect(sameSnapshot(snapshot(), snapshot())).toBe(true);
  });

  it.each([
    { label: "another game", other: snapshot(FOOLS_MATE, { gameId: OTHER_GAME_ID }) },
    { label: "another revision", other: snapshot(FOOLS_MATE, { version: 5 }) },
    { label: "a shorter history", other: snapshot(FOOLS_MATE.slice(0, 3)) },
    {
      label: "a different terminal history",
      other: snapshot(["e2e4", "f7f6", "d2d4", "g7g5", "d1h5"]),
    },
    {
      label: "one altered move record",
      other: {
        ...snapshot(FOOLS_MATE),
        moves: snapshot(FOOLS_MATE).moves.map((move, index) =>
          index === 3 ? { ...move, san: "Qh4" } : move,
        ),
      },
    },
    {
      label: "different PGN text",
      other: { ...snapshot(FOOLS_MATE), pgn: "1. f3 e5 2. g4 Qh4# 0-1" },
    },
    {
      label: "a different side to move",
      other: { ...snapshot(FOOLS_MATE), turn: "black" as const },
    },
  ])("distinguishes $label", ({ other }) => {
    expect(sameSnapshot(snapshot(FOOLS_MATE), other)).toBe(false);
  });
});
