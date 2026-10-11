import { z } from "zod";

import { gameIdSchema } from "./game.js";

const plySchema = z.int().min(0).max(2_147_483_647);
export const analysisProfileIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);
export const analysisScoreSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cp"), value: z.int().min(-100_000).max(100_000) }),
  z.strictObject({
    kind: z.literal("mate"),
    winner: z.enum(["white", "black"]),
    moves: z.int().min(0).max(128),
  }),
]);
const sampleFields = {
  ply: plySchema,
  fen: z.string().min(1).max(128),
  historyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  profileId: analysisProfileIdSchema,
  depth: z.int().min(0).max(18),
  durationMs: z.int().min(0).max(3000),
  score: analysisScoreSchema,
};
export const analysisSampleSchema = z
  .strictObject(sampleFields)
  .refine((sample) => new TextEncoder().encode(JSON.stringify(sample)).byteLength <= 1024);
export const storedAnalysisSampleSchema = z.strictObject({
  ...sampleFields,
  recordedAt: z.iso.datetime(),
});
export const analysisWriteRequestSchema = z.strictObject({
  samples: z
    .array(analysisSampleSchema)
    .min(1)
    .max(32)
    .refine((samples) => new Set(samples.map((sample) => sample.ply)).size === samples.length),
});
export const analysisCursorSchema = z
  .string()
  .max(85)
  .refine((cursor) => {
    const parts = cursor.split("_");
    return (
      parts.length === 3 &&
      gameIdSchema.safeParse(parts[0]).success &&
      z.uuid().safeParse(parts[1]).success &&
      /^(0|[1-9]\d*)$/.test(parts[2] ?? "") &&
      plySchema.safeParse(Number(parts[2])).success
    );
  });
export const analysisQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(128).default(128),
  cursor: analysisCursorSchema.optional(),
});
export const analysisWriteResponseSchema = z.strictObject({
  gameId: gameIdSchema,
  samples: z.array(storedAnalysisSampleSchema).min(1).max(32),
});
export const analysisReadResponseSchema = z.strictObject({
  gameId: gameIdSchema,
  samples: z.array(storedAnalysisSampleSchema).max(128),
  nextCursor: analysisCursorSchema.nullable(),
});
export const analysisObsoleteResponseSchema = z.strictObject({
  code: z.literal("profile_obsolete"),
  currentProfileId: analysisProfileIdSchema,
  requestId: z.string(),
});
export type AnalysisScore = z.infer<typeof analysisScoreSchema>;
export type AnalysisSample = z.infer<typeof analysisSampleSchema>;
export type StoredAnalysisSample = z.infer<typeof storedAnalysisSampleSchema>;
export type AnalysisWriteRequest = z.infer<typeof analysisWriteRequestSchema>;
export type AnalysisWriteResponse = z.infer<typeof analysisWriteResponseSchema>;
export type AnalysisReadResponse = z.infer<typeof analysisReadResponseSchema>;
export type AnalysisQuery = z.infer<typeof analysisQuerySchema>;
