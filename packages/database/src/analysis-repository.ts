import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { gameAnalysisSamples } from "./schema/analysis.js";

export type StoredAnalysisRecord = typeof gameAnalysisSamples.$inferSelect;
export type NewAnalysisRecord = Omit<StoredAnalysisRecord, "recordedAt">;
export interface AnalysisReader {
  getAnalysisSamples(
    userId: string,
    gameId: string,
    limit: number,
    afterPly?: number,
  ): Promise<StoredAnalysisRecord[]>;
}
export interface AnalysisTransaction {
  lockAnalysisSample(
    userId: string,
    gameId: string,
    ply: number,
  ): Promise<StoredAnalysisRecord | undefined>;
  saveAnalysisSample(sample: NewAnalysisRecord): Promise<StoredAnalysisRecord>;
}
type Executor = Pick<DatabaseConnection["db"], "select" | "insert">;
export function analysisReaderFor(db: Pick<Executor, "select">): AnalysisReader {
  return {
    getAnalysisSamples: (userId, gameId, limit, afterPly) =>
      db
        .select()
        .from(gameAnalysisSamples)
        .where(
          and(
            eq(gameAnalysisSamples.userId, userId),
            eq(gameAnalysisSamples.gameId, gameId),
            afterPly === undefined ? undefined : gt(gameAnalysisSamples.ply, afterPly),
          ),
        )
        .orderBy(asc(gameAnalysisSamples.ply))
        .limit(limit),
  };
}
export function analysisTransactionFor(db: Executor): AnalysisTransaction {
  return {
    async lockAnalysisSample(userId, gameId, ply) {
      const [sample] = await db
        .select()
        .from(gameAnalysisSamples)
        .where(
          and(
            eq(gameAnalysisSamples.userId, userId),
            eq(gameAnalysisSamples.gameId, gameId),
            eq(gameAnalysisSamples.ply, ply),
          ),
        )
        .for("update");
      return sample;
    },
    // The authorized account/game lock serializes absent rows as well as replacements.
    async saveAnalysisSample(sample) {
      const [saved] = await db
        .insert(gameAnalysisSamples)
        .values(sample)
        .onConflictDoUpdate({
          target: [gameAnalysisSamples.userId, gameAnalysisSamples.gameId, gameAnalysisSamples.ply],
          set: { ...sample, recordedAt: sql`clock_timestamp()` },
        })
        .returning();
      if (!saved) throw new Error("Analysis persistence failed");
      return saved;
    },
  };
}
