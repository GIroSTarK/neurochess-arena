import { expect, it } from "vitest";

import {
  analysisReadResponseSchema,
  analysisSampleSchema,
  analysisScoreSchema,
  analysisWriteRequestSchema,
} from "./analysis.js";

const sample = {
  ply: 0,
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  historyDigest: "a".repeat(64),
  profileId: "sf19-lite-single-v1",
  depth: 18,
  durationMs: 3000,
  score: { kind: "cp", value: 0 },
};

it("preserves exact signed centipawns and separate mate values including zero", () => {
  for (const score of [
    { kind: "cp", value: -100000 },
    { kind: "cp", value: 0 },
    { kind: "cp", value: 100000 },
    { kind: "mate", winner: "white", moves: 0 },
    { kind: "mate", winner: "black", moves: 128 },
  ]) {
    expect(analysisScoreSchema.parse(score)).toEqual(score);
  }
  for (const score of [
    { kind: "cp", value: Infinity },
    { kind: "cp", value: NaN },
    { kind: "cp", value: 1.5 },
    { kind: "mate", winner: "white", moves: 0.5 },
    { kind: "cp", value: 0, bound: "lowerbound" },
  ]) {
    expect(analysisScoreSchema.safeParse(score).success).toBe(false);
  }
});

it("bounds serialized scalar samples, distinct write plies and read pages", () => {
  expect(analysisSampleSchema.parse(sample)).toEqual(sample);
  expect(
    analysisSampleSchema.safeParse({
      ...sample,
      ply: 2_147_483_647,
      fen: "\u0000".repeat(128),
      profileId: "a".repeat(64),
      score: { kind: "mate", winner: "white", moves: 128 },
    }).success,
  ).toBe(false);
  const samples = Array.from({ length: 32 }, (_, ply) => ({ ...sample, ply }));
  expect(analysisWriteRequestSchema.safeParse({ samples }).success).toBe(true);
  expect(
    analysisWriteRequestSchema.safeParse({ samples: [...samples, { ...sample, ply: 32 }] }).success,
  ).toBe(false);
  expect(analysisWriteRequestSchema.safeParse({ samples: [sample, sample] }).success).toBe(false);
  const read = {
    gameId: "b54013cf-888d-4656-9f6c-6f4b11232aee",
    nextCursor: null,
    samples: Array.from({ length: 128 }, (_, ply) => ({
      ...sample,
      ply,
      recordedAt: "2026-10-11T00:00:00.000Z",
    })),
  };
  expect(analysisReadResponseSchema.safeParse(read).success).toBe(true);
  expect(
    analysisReadResponseSchema.safeParse({ ...read, samples: [...read.samples, read.samples[0]] })
      .success,
  ).toBe(false);
});
